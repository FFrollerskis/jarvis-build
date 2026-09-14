import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONSERVATIVE_EPHEMERAL_LOW,
  FENCE_REASON,
  LEASE_DIR_ID_FILE,
  RECLAIM_VERDICT,
  SAFETY_FLOOR,
  TAKEOVER_REJECTED,
  acquirePortLease,
  candidateWindow,
  ensureLeaseDirId,
  heldLeaseCount,
  highestEpoch,
  readEphemeralRange,
  readLeaseDirId,
  reclaimVerdict,
  takeOverEpoch,
  type CandidateWindow,
  type EphemeralRangeReading,
  type LeaseDocument,
  type LeaseOwner
} from "../src/testing/index.ts";

/**
 * D-142 A - OBLIGATORISK LEIEBEVIS.
 *
 * D-141 gjorde overtakelse betinget av den eksakte generasjonen kalleren
 * inspiserte. Det holdt innenfor ÉN sammenhengende serie - men generasjonen ble
 * utledet av filene som laa der, og `release()` SLETTET filen. Slapp den siste
 * eieren, startet telleren paa 1 igjen, og ABA var tilbake:
 *
 *     A inspiserer 1 -> B tar 2 og RELEASER -> C tar 1 paa nytt -> A tar 2 og
 *     pruner C vekk.
 *
 * Denne suiten beviser at hoeyvannsmerket naa er DURABELT: en frigjoering
 * skriver gravstein i stedet for aa slette, en overtakelse verifiserer at den
 * faktisk ER hoeyvannsmerket etter at stien er sikret, en reinkarnert leiekatalog
 * feiler lukket, og en forbigaatt eller utloept eier blir FENCED - den kan verken
 * skrive, prune eller frigjoere noe etterpaa.
 */

let leaseDir: string;
let dirId: string;

beforeEach(() => {
  leaseDir = mkdtempSync(join(tmpdir(), "jarvis-lease-test-"));
  dirId = ensureLeaseDirId(leaseDir);
});

afterEach(() => {
  rmSync(leaseDir, { recursive: true, force: true });
});

const window4: CandidateWindow = { low: 20000, high: 20003, proven: true, basis: "test" };
const alive = () => true;
const dead = () => false;
const onePort = (port: number): CandidateWindow => ({ low: port, high: port, proven: true, basis: "test" });

interface PlantOverrides {
  readonly owner?: LeaseOwner;
  readonly heartbeat_at_ms?: number;
  readonly ttl_ms?: number;
  readonly state?: "held" | "released";
}

/** Legger en leie paa disk slik en annen prosess ville gjort det. */
function plantLease(dir: string, port: number, epoch: number, over: PlantOverrides = {}): string {
  const doc: LeaseDocument = {
    v: 3,
    port,
    epoch,
    dir_id: readLeaseDirId(dir) ?? "",
    state: over.state ?? "held",
    owner: over.owner ?? { pid: 999_999, uuid: "planted-" + epoch, host: hostname(), acquired_at_ms: 0 },
    heartbeat_at_ms: over.heartbeat_at_ms ?? 0,
    ttl_ms: over.ttl_ms ?? 60_000,
    released_at_ms: null
  };
  const file = join(dir, `${port}.${epoch}.lease`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function leaseNames(dir: string, port: number): string[] {
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${port}.`))
    .sort();
}

function readDoc(file: string): LeaseDocument {
  return JSON.parse(readFileSync(file, "utf8")) as LeaseDocument;
}

function ownerUuid(file: string): string {
  return readDoc(file).owner.uuid;
}

const someOwner = (uuid: string, at = 0): LeaseOwner => ({ pid: process.pid, uuid, host: hostname(), acquired_at_ms: at });

describe("A.4: det efemere intervallet leses - det antas aldri", () => {
  it("leser Linux ip_local_port_range som et FAKTISK intervall", () => {
    const r = readEphemeralRange({ platform: "linux", readFile: () => "32768\t60999\n" });
    expect(r).toEqual({ kind: "read", low: 32768, high: 60999, source: "/proc/sys/net/ipv4/ip_local_port_range" });
  });

  it("leser Windows dynamicport via netsh (tall, ikke lokaliserte etiketter)", () => {
    const netsh = ["Protocol tcp Dynamic Port Range", "---------------------------------", "Start Port      : 49152", "Number of Ports : 16384"].join("\n");
    const r = readEphemeralRange({ platform: "win32", runCommand: () => netsh });
    expect(r).toEqual({ kind: "read", low: 49152, high: 65535, source: "netsh int ipv4 show dynamicport tcp" });
  });

  it("leser macOS portrange via sysctl", () => {
    const r = readEphemeralRange({ platform: "darwin", runCommand: () => "49152\n65535\n" });
    expect(r.kind).toBe("read");
    if (r.kind === "read") expect([r.low, r.high]).toEqual([49152, 65535]);
  });

  it("en kilde som kaster er UNREADABLE - ikke et stille default", () => {
    const r = readEphemeralRange({
      platform: "linux",
      readFile: () => {
        throw new Error("EACCES");
      }
    });
    expect(r.kind).toBe("unreadable");
    if (r.kind === "unreadable") expect(r.detail).toContain("EACCES");
  });

  it("soppel i kilden er UNREADABLE, ikke et gjettet intervall", () => {
    const r = readEphemeralRange({ platform: "linux", readFile: () => "ikke tall i det hele tatt" });
    expect(r.kind).toBe("unreadable");
  });

  it("et bakvendt/ugyldig intervall er UNREADABLE", () => {
    const r = readEphemeralRange({ platform: "linux", readFile: () => "60999 32768" });
    expect(r.kind).toBe("unreadable");
  });

  it("en plattform uten kjent kilde er UNSUPPORTED", () => {
    const r = readEphemeralRange({ platform: "aix" });
    expect(r).toEqual({ kind: "unsupported", platform: "aix" });
  });

  it("leser den EKTE verten uten aa kaste, uansett plattform", () => {
    const r = readEphemeralRange();
    expect(["read", "unreadable", "unsupported"]).toContain(r.kind);
  });
});

describe("A.4: kandidatvinduet - bevist disjunkt, eller aerlig merket som antatt", () => {
  it("et lest intervall gir et BEVIST vindu strengt under det", () => {
    const w = candidateWindow({ kind: "read", low: 32768, high: 60999, source: "s" });
    expect(w.proven).toBe(true);
    expect(w.high).toBe(32767);
    expect(w.low).toBeGreaterThanOrEqual(SAFETY_FLOOR);
  });

  it("nedre grense JUST OVER gulvet gir fortsatt et bevist vindu under", () => {
    const w = candidateWindow({ kind: "read", low: SAFETY_FLOOR + 2, high: 60999, source: "s" });
    expect(w.proven).toBe(true);
    expect(w.high).toBe(SAFETY_FLOOR + 1);
    expect(w.low).toBeGreaterThanOrEqual(SAFETY_FLOOR);
  });

  it("nedre grense LIK gulvet gir et bevist vindu OVER intervallet - aldri 32768 i smug", () => {
    const w = candidateWindow({ kind: "read", low: SAFETY_FLOOR, high: 50000, source: "s" });
    expect(w.proven).toBe(true);
    expect(w.low).toBe(50001);
    expect(w.low).toBeGreaterThan(CONSERVATIVE_EPHEMERAL_LOW);
  });

  it("nedre grense UNDER gulvet gir ogsaa et disjunkt vindu over, ikke en substitusjon", () => {
    const w = candidateWindow({ kind: "read", low: 1024, high: 40000, source: "s" });
    expect(w.proven).toBe(true);
    expect(w.low).toBe(40001);
  });

  it("et intervall som dekker ALT feiler lukket i stedet for aa gjette", () => {
    expect(() => candidateWindow({ kind: "read", low: 1024, high: 65535, source: "s" })).toThrow(/Feiler lukket/);
  });

  it("uleselig kilde gir et ANTATT vindu som eksplisitt IKKE er bevist", () => {
    const r: EphemeralRangeReading = { kind: "unreadable", source: "s", detail: "EACCES" };
    const w = candidateWindow(r);
    expect(w.proven).toBe(false);
    expect(w.basis).toMatch(/IKKE leses/);
    expect(w.basis).toMatch(/IKKE bevist disjunkt/);
    expect(w.high).toBeLessThan(CONSERVATIVE_EPHEMERAL_LOW);
  });

  it("ustoettet plattform gir samme aerlige, ikke-beviste verdikt", () => {
    const w = candidateWindow({ kind: "unsupported", platform: "aix" });
    expect(w.proven).toBe(false);
    expect(w.basis).toContain("aix");
  });
});

describe("A.1: hoeyvannsmerket er DURABELT - en frigjoering nullstiller ingenting", () => {
  it("en ubrukt port gir epoke 1, og epoken ligger i filnavnet", () => {
    const lease = acquirePortLease({ leaseDir, window: onePort(20400), heartbeat: false });
    expect(lease.epoch).toBe(1);
    expect(lease.file).toBe(join(leaseDir, "20400.1.lease"));
    expect(highestEpoch(leaseDir, 20400)).toEqual({ epoch: 1, file: lease.file });
    lease.release();
  });

  it("release skriver GRAVSTEIN - den sletter ikke, og epoken blir staaende", () => {
    const lease = acquirePortLease({ leaseDir, window: onePort(20401), heartbeat: false, now: () => 5_000 });
    lease.release();

    // Selve kjernen i D-142 A.1: filen finnes fortsatt.
    expect(existsSync(lease.file)).toBe(true);
    const doc = readDoc(lease.file);
    expect(doc.state).toBe("released");
    expect(doc.epoch).toBe(1);
    expect(doc.owner.uuid).toBe(lease.owner.uuid);
    expect(doc.released_at_ms).toBe(5_000);
    expect(highestEpoch(leaseDir, 20401).epoch).toBe(1);
  });

  it("en gravstein er LEDIG, men epoken deles aldri ut paa nytt", () => {
    const first = acquirePortLease({ leaseDir, window: onePort(20402), heartbeat: false });
    expect(first.epoch).toBe(1);
    first.release();

    const second = acquirePortLease({ leaseDir, window: onePort(20402), heartbeat: false });
    expect(second.port).toBe(20402);
    expect(second.epoch).toBe(2);
    expect(second.file).not.toBe(first.file);
    second.release();
  });

  it("MANGE fulle sykluser: verken epoke eller sti gjentas noen gang", () => {
    const port = 20403;
    const epochs: number[] = [];
    const paths: string[] = [];
    for (let i = 0; i < 12; i++) {
      const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
      epochs.push(lease.epoch);
      paths.push(lease.file);
      lease.release();
    }
    expect(epochs).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(new Set(paths).size).toBe(12);
    // Og katalogen vokser ikke: kun hoeyvannsmerket staar igjen.
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.12.lease`]);
    expect(highestEpoch(leaseDir, port).epoch).toBe(12);
  });

  it("DETERMINISTISK RESET-ABA: den forsinkede aktoeren kan verken skaffe seg noe eller roere C", () => {
    const port = 20700;

    // Den stale leien BAADE A og B inspiserer.
    plantLease(leaseDir, port, 1);
    const inspectedByA = highestEpoch(leaseDir, port);
    const dirIdSeenByA = readLeaseDirId(leaseDir)!;
    expect(inspectedByA.epoch).toBe(1);

    // B tar over og RELEASER - noeyaktig det tomme vinduet D-141 nullstilte i.
    const b = acquirePortLease({ leaseDir, window: onePort(port), staleAfterMs: 1, isProcessAlive: dead, heartbeat: false });
    expect(b.epoch).toBe(2);
    b.release();

    // C skaffer seg porten etter det tomme vinduet. Under D-141 fikk C epoke 1
    // paa nytt; naa staar gravsteinen, saa C faar 3.
    const c = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    expect(c.epoch).toBe(3);
    const cSnapshot = readFileSync(c.file, "utf8");

    // A handler NAA paa sin foreldede lesning av epoke 1.
    const delayedA = takeOverEpoch({
      leaseDir,
      port,
      inspectedEpoch: inspectedByA.epoch,
      inspectedDirId: dirIdSeenByA,
      owner: someOwner("forsinket-A", 2_000),
      ttlMs: 60_000
    });

    // A kan ikke skaffe seg noe: stien var ledig (epoke 2 ble ryddet), men A er
    // ikke hoeyvannsmerket. Den trakk seg og fjernet kun sin egen fil.
    expect(delayedA.ok).toBe(false);
    if (!delayedA.ok) expect(delayedA.reason).toBe(TAKEOVER_REJECTED.NOT_HIGHEST_EPOCH);

    // C staar BYTE-IDENTISK, og A etterlot seg ingenting.
    expect(existsSync(c.file)).toBe(true);
    expect(readFileSync(c.file, "utf8")).toBe(cSnapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.3.lease`]);
    expect(c.verifyOwnership().ok).toBe(true);
    c.release();
  });

  it("den forsinkede aktoeren taper ogsaa naar epoken FINNES: ingenting opprettes, ingenting rives", () => {
    const port = 20701;
    plantLease(leaseDir, port, 3);

    const successor = takeOverEpoch({
      leaseDir,
      port,
      inspectedEpoch: 3,
      inspectedDirId: dirId,
      owner: someOwner("etterfoelger", 1_000),
      ttlMs: 60_000
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const snapshot = readFileSync(successor.file, "utf8");

    const loser = takeOverEpoch({
      leaseDir,
      port,
      inspectedEpoch: 3,
      inspectedDirId: dirId,
      owner: someOwner("taper", 2_000),
      ttlMs: 60_000
    });
    expect(loser.ok).toBe(false);
    if (!loser.ok) expect(loser.reason).toBe(TAKEOVER_REJECTED.LOST_EPOCH_RACE);

    expect(readFileSync(successor.file, "utf8")).toBe(snapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.4.lease`]);
  });

  it("bare EN av mange samtidige overtakere av samme epoke lykkes", () => {
    const port = 20702;
    plantLease(leaseDir, port, 3);
    const results = [0, 1, 2, 3, 4, 5].map((i) =>
      takeOverEpoch({ leaseDir, port, inspectedEpoch: 3, inspectedDirId: dirId, owner: someOwner("kandidat-" + i, i), ttlMs: 60_000 })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.4.lease`]);
  });

  it("opprydding fjerner KUN strengt lavere epoker", () => {
    const port = 20703;
    plantLease(leaseDir, port, 1);
    plantLease(leaseDir, port, 2);
    const taken = takeOverEpoch({ leaseDir, port, inspectedEpoch: 2, inspectedDirId: dirId, owner: someOwner("ny"), ttlMs: 60_000 });
    expect(taken.ok).toBe(true);
    if (taken.ok) expect(taken.epoch).toBe(3);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.3.lease`]);
  });

  it("en REINKARNERT leiekatalog feiler lukket - den ferske eieren overlever", () => {
    const port = 20704;
    plantLease(leaseDir, port, 5);
    const staleDirId = readLeaseDirId(leaseDir)!;
    expect(highestEpoch(leaseDir, port).epoch).toBe(5);

    // Katalogen slettes og gjenskapes under oss. En fersk eier tar epoke 1.
    rmSync(leaseDir, { recursive: true, force: true });
    mkdirSync(leaseDir, { recursive: true });
    const freshDirId = ensureLeaseDirId(leaseDir);
    expect(freshDirId).not.toBe(staleDirId);
    const fresh = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    expect(fresh.epoch).toBe(1);
    const freshSnapshot = readFileSync(fresh.file, "utf8");

    // Den forsinkede aktoeren fra FORRIGE inkarnasjon proever epoke 6.
    const delayed = takeOverEpoch({
      leaseDir,
      port,
      inspectedEpoch: 5,
      inspectedDirId: staleDirId,
      owner: someOwner("fra-forrige-inkarnasjon"),
      ttlMs: 60_000
    });
    expect(delayed.ok).toBe(false);
    if (!delayed.ok) expect(delayed.reason).toBe(TAKEOVER_REJECTED.LEASE_DIR_REINCARNATED);

    // Den ferske eieren er uroert, og ingen epoke-6-fil ble liggende igjen.
    expect(readFileSync(fresh.file, "utf8")).toBe(freshSnapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.1.lease`]);
    expect(fresh.verifyOwnership().ok).toBe(true);
    fresh.release();
  });

  it("inkarnasjons-iden opprettes én gang og er stabil", () => {
    const again = ensureLeaseDirId(leaseDir);
    expect(again).toBe(dirId);
    expect(readLeaseDirId(leaseDir)).toBe(dirId);
    expect(existsSync(join(leaseDir, LEASE_DIR_ID_FILE))).toBe(true);
    // Id-filen forveksles aldri med en leie.
    expect(highestEpoch(leaseDir, 20705).epoch).toBe(0);
  });
});

describe("A.2: hvem som lever - og hva vi gjoer naar vi ikke vet", () => {
  const doc = (over: { heartbeat_at_ms?: number; ttl_ms?: number; host?: string; state?: "held" | "released" } = {}): LeaseDocument => ({
    v: 3,
    port: 1234,
    epoch: 1,
    dir_id: "x",
    state: over.state ?? "held",
    heartbeat_at_ms: over.heartbeat_at_ms ?? 0,
    ttl_ms: over.ttl_ms ?? 60_000,
    owner: { pid: 4242, uuid: "u", host: over.host ?? hostname(), acquired_at_ms: 0 },
    released_at_ms: null
  });

  const ctx = (over: { isProcessAlive?: (pid: number) => boolean } = {}) => ({
    now: 10_000_000,
    staleAfterMs: 1_000,
    hostId: hostname(),
    isProcessAlive: over.isProcessAlive ?? dead
  });

  it("en GRAVSTEIN er ledig - ogsaa naar eierprosessen fortsatt lever", () => {
    expect(reclaimVerdict(doc({ state: "released" }), ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.RECLAIMABLE_RELEASED);
  });

  it("samme vert, eieren LEVER: aldri, uansett alder", () => {
    expect(reclaimVerdict(doc(), ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.HELD_LOCAL_OWNER_ALIVE);
  });

  it("samme vert, eieren LEVER og heartbeaten er UTLOEPT: fortsatt aldri", () => {
    // A.3: en vridd, men levende prosess kan fortsatt holde socketen. En
    // overtakelse her ville gitt to eiere av samme ressurs.
    const wedged = doc({ heartbeat_at_ms: 0, ttl_ms: 1_000 });
    expect(reclaimVerdict(wedged, ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.HELD_LOCAL_OWNER_ALIVE);
  });

  it("samme vert, eieren er DOED men leien FERSK: aldri", () => {
    expect(reclaimVerdict(doc({ heartbeat_at_ms: 9_999_500 }), ctx())).toBe(RECLAIM_VERDICT.HELD_TOO_FRESH);
  });

  it("samme vert, eieren er DOED og leien GAMMEL: kan tas over", () => {
    expect(reclaimVerdict(doc(), ctx())).toBe(RECLAIM_VERDICT.RECLAIMABLE_DEAD_OWNER);
  });

  it("ANNEN vert med GYLDIG heartbeat: aldri - en levende eier stjeles ikke", () => {
    const remote = doc({ heartbeat_at_ms: 9_999_999, ttl_ms: 60_000, host: "en-annen-maskin" });
    expect(reclaimVerdict(remote, ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.HELD_REMOTE_HEARTBEAT_VALID);
    // Og lokal pid-liveness er irrelevant: svaret er det samme uansett.
    expect(reclaimVerdict(remote, ctx({ isProcessAlive: dead }))).toBe(RECLAIM_VERDICT.HELD_REMOTE_HEARTBEAT_VALID);
  });

  it("ANNEN vert UTEN verifiserbar heartbeat: fail-closed, ikke fail-open", () => {
    const noHeartbeat = doc({ heartbeat_at_ms: Number.NaN, host: "en-annen-maskin" });
    expect(reclaimVerdict(noHeartbeat, ctx())).toBe(RECLAIM_VERDICT.HELD_REMOTE_UNVERIFIABLE);
    const noTtl = doc({ ttl_ms: 0, host: "en-annen-maskin" });
    expect(reclaimVerdict(noTtl, ctx())).toBe(RECLAIM_VERDICT.HELD_REMOTE_UNVERIFIABLE);
  });

  it("ANNEN vert med UTLOEPT heartbeat: da - og bare da - kan den tas over", () => {
    const expired = doc({ heartbeat_at_ms: 0, ttl_ms: 1_000, host: "en-annen-maskin" });
    expect(reclaimVerdict(expired, ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.RECLAIMABLE_EXPIRED);
  });

  it("en ULESELIG leie er ALDRI stale - vi vet ikke hvem som eier den", () => {
    expect(reclaimVerdict(null, ctx())).toBe(RECLAIM_VERDICT.HELD_UNREADABLE);
  });

  it("ende-til-ende: gammel+doed gjenbrukes, gammel+LEVENDE gjoer det ikke", () => {
    const port = 20600;
    plantLease(leaseDir, port, 1, { owner: { pid: 999_999, uuid: "gammel", host: hostname(), acquired_at_ms: 0 } });

    const taken = acquirePortLease({ leaseDir, window: onePort(port), staleAfterMs: 1_000, now: () => 1_000_000, isProcessAlive: dead, heartbeat: false });
    expect(taken.port).toBe(port);
    expect(taken.epoch).toBe(2);
    expect(ownerUuid(taken.file)).not.toBe("gammel");
    taken.release();

    const liveFile = plantLease(leaseDir, port, 5, { owner: { pid: 4242, uuid: "levende", host: hostname(), acquired_at_ms: 0 } });
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), staleAfterMs: 1_000, now: () => 1_000_000, isProcessAlive: alive, heartbeat: false })
    ).toThrow(/Fikk ingen eksklusiv portleie/);
    expect(ownerUuid(liveFile)).toBe("levende");
  });

  it("ende-til-ende: en FERSK doed leie er ikke forlatt - porten blokkeres", () => {
    const port = 20605;
    const file = plantLease(leaseDir, port, 1, {
      heartbeat_at_ms: 999_500,
      owner: { pid: 999_999, uuid: "nettopp-doed", host: hostname(), acquired_at_ms: 999_500 }
    });
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), staleAfterMs: 60_000, now: () => 1_000_000, isProcessAlive: dead, heartbeat: false })
    ).toThrow(new RegExp(RECLAIM_VERDICT.HELD_TOO_FRESH));
    expect(ownerUuid(file)).toBe("nettopp-doed");
  });

  it("ende-til-ende: en KRYSSVERT-leie med gyldig heartbeat kan ikke tas - og feilen sier hvorfor", () => {
    const port = 20601;
    const file = plantLease(leaseDir, port, 1, {
      heartbeat_at_ms: 999_000,
      ttl_ms: 60_000,
      owner: { pid: 4242, uuid: "fjern-og-levende", host: "en-annen-maskin", acquired_at_ms: 0 }
    });
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), now: () => 1_000_000, isProcessAlive: dead, heartbeat: false })
    ).toThrow(new RegExp(RECLAIM_VERDICT.HELD_REMOTE_HEARTBEAT_VALID));
    expect(ownerUuid(file)).toBe("fjern-og-levende");
  });

  it("ende-til-ende: en KRYSSVERT-leie uten heartbeat feiler LUKKET", () => {
    const port = 20602;
    const file = plantLease(leaseDir, port, 1, {
      ttl_ms: 0,
      owner: { pid: 4242, uuid: "fjern-og-ukjent", host: "en-annen-maskin", acquired_at_ms: 0 }
    });
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), now: () => 1_000_000, isProcessAlive: dead, heartbeat: false })
    ).toThrow(new RegExp(RECLAIM_VERDICT.HELD_REMOTE_UNVERIFIABLE));
    expect(ownerUuid(file)).toBe("fjern-og-ukjent");
  });

  it("ende-til-ende: en KRYSSVERT-leie med UTLOEPT heartbeat kan tas over - og epoken gaar opp", () => {
    const port = 20603;
    plantLease(leaseDir, port, 1, {
      heartbeat_at_ms: 1_000,
      ttl_ms: 1_000,
      owner: { pid: 4242, uuid: "fjern-og-forlatt", host: "en-annen-maskin", acquired_at_ms: 0 }
    });
    const lease = acquirePortLease({ leaseDir, window: onePort(port), now: () => 1_000_000, isProcessAlive: alive, heartbeat: false });
    expect(lease.epoch).toBe(2);
    expect(ownerUuid(lease.file)).toBe(lease.owner.uuid);
    lease.release();
  });

  it("ende-til-ende: en ULESELIG leie blokkerer porten i stedet for aa bli revet vekk", () => {
    const port = 20604;
    const file = join(leaseDir, `${port}.1.lease`);
    writeFileSync(file, "{ dette er ikke gyldig json");
    expect(() => acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false })).toThrow(
      new RegExp(RECLAIM_VERDICT.HELD_UNREADABLE)
    );
    expect(readFileSync(file, "utf8")).toBe("{ dette er ikke gyldig json");
  });

  it("et etterlatt D-141-dokument (v2) leses som holdt - det blokkerer, det forsvinner ikke", () => {
    const port = 20606;
    const file = join(leaseDir, `${port}.4.lease`);
    writeFileSync(
      file,
      JSON.stringify({
        v: 2,
        port,
        generation: 4,
        owner: { pid: 4242, uuid: "v2-eier", host: hostname(), acquired_at_ms: 0 },
        heartbeat_at_ms: 999_000,
        ttl_ms: 60_000
      })
    );
    expect(highestEpoch(leaseDir, port).epoch).toBe(4);
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), now: () => 1_000_000, isProcessAlive: alive, heartbeat: false })
    ).toThrow(new RegExp(RECLAIM_VERDICT.HELD_LOCAL_OWNER_ALIVE));
    expect(ownerUuid(file)).toBe("v2-eier");
  });
});

describe("A.2/A.3: en forbigaatt eller utloept eier blir FENCED - og roerer aldri disk igjen", () => {
  it("en hoeyere epoke fencer oss: vi er ikke autoritative lenger", () => {
    const port = 20900;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    expect(lease.verifyOwnership().ok).toBe(true);

    plantLease(leaseDir, port, lease.epoch + 1, { owner: someOwner("etterfoelger") });

    const verdict = lease.verifyOwnership();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(FENCE_REASON.SUPERSEDED_BY_HIGHER_EPOCH);
    expect(lease.fenced).toBe(true);
    expect(lease.released).toBe(true);
    expect(() => lease.assertOwned()).toThrow(/ikke lenger vaar/);
  });

  it("en FENCED eier kan verken skrive gravstein, prune eller frigjoere noe", () => {
    const port = 20901;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    const successorFile = plantLease(leaseDir, port, lease.epoch + 1, { owner: someOwner("etterfoelger") });
    const successorSnapshot = readFileSync(successorFile, "utf8");
    const ownSnapshot = readFileSync(lease.file, "utf8");

    lease.verifyOwnership(); // fencer oss
    expect(lease.fenced).toBe(true);

    lease.release();
    lease.release();

    // Ingenting er endret: heller ikke vaar EGEN fil, for vi hadde ingen rett
    // til aa si noe om den lenger.
    expect(readFileSync(successorFile, "utf8")).toBe(successorSnapshot);
    expect(readFileSync(lease.file, "utf8")).toBe(ownSnapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.1.lease`, `${port}.2.lease`]);
  });

  it("en ZOMBIE kan ikke fornye seg tilbake til autoritet over sin egen TTL", () => {
    const port = 20902;
    let clock = 1_000_000;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), ttlMs: 10_000, heartbeat: false, now: () => clock });
    expect(lease.verifyOwnership().ok).toBe(true);

    // Prosessen har ligget suspendert forbi sin egen TTL.
    clock = 1_000_000 + 10_001;

    const verdict = lease.verifyOwnership();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(FENCE_REASON.OWN_LEASE_EXPIRED);
    expect(lease.fenced).toBe(true);
    // Heartbeaten i filen staar uroert paa det den var - ingen selvfornyelse.
    expect(readDoc(lease.file).heartbeat_at_ms).toBe(1_000_000);
    expect(readDoc(lease.file).state).toBe("held");
  });

  it("en borte leiefil fencer oss - vi gjenoppretter den ikke", () => {
    const port = 20903;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    rmSync(lease.file, { force: true });

    const verdict = lease.verifyOwnership();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(FENCE_REASON.LEASE_FILE_GONE);
    lease.release();
    expect(existsSync(lease.file)).toBe(false);
  });

  it("en overskrevet eier fencer oss - vi tar ikke stien tilbake", () => {
    const port = 20904;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    writeFileSync(
      lease.file,
      JSON.stringify({ v: 3, port, epoch: lease.epoch, dir_id: dirId, state: "held", owner: someOwner("noen-andre"), heartbeat_at_ms: 0, ttl_ms: 60_000, released_at_ms: null })
    );
    const snapshot = readFileSync(lease.file, "utf8");

    const verdict = lease.verifyOwnership();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(FENCE_REASON.OWNER_REPLACED);
    lease.release();
    expect(readFileSync(lease.file, "utf8")).toBe(snapshot);
  });

  it("en reinkarnert katalog fencer en holdt leie", () => {
    const port = 20905;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    rmSync(join(leaseDir, LEASE_DIR_ID_FILE), { force: true });
    ensureLeaseDirId(leaseDir);

    const verdict = lease.verifyOwnership();
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe(FENCE_REASON.LEASE_DIR_REINCARNATED);
  });

  it("onFenced varsler kalleren slik at ressursen kan rives ned", () => {
    const port = 20906;
    const seen: string[] = [];
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false, onFenced: (reason) => seen.push(reason) });
    plantLease(leaseDir, port, lease.epoch + 1, { owner: someOwner("etterfoelger") });

    lease.verifyOwnership();
    lease.verifyOwnership(); // idempotent - fencing varsles én gang
    expect(seen).toEqual([FENCE_REASON.SUPERSEDED_BY_HIGHER_EPOCH]);
  });

  it("fencing tar leien ut av bokfoeringen, akkurat som en frigjoering", () => {
    const port = 20907;
    const start = heldLeaseCount();
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    expect(heldLeaseCount()).toBe(start + 1);
    plantLease(leaseDir, port, lease.epoch + 1, { owner: someOwner("etterfoelger") });
    lease.verifyOwnership();
    expect(heldLeaseCount()).toBe(start);
  });

  it("HEARTBEAT-kapploep: en forbigaatt eier fornyer ingenting, og etterfoelgeren staar uroert", async () => {
    const port = 20908;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeatIntervalMs: 20 });
    const ownHeartbeatBefore = readDoc(lease.file).heartbeat_at_ms;

    const successorFile = plantLease(leaseDir, port, lease.epoch + 1, { owner: someOwner("etterfoelger") });
    const successorSnapshot = readFileSync(successorFile, "utf8");

    // La heartbeat-timeren faa flere sjanser til aa gjoere skade.
    await new Promise((r) => setTimeout(r, 200));

    expect(lease.fenced).toBe(true);
    expect(lease.fenceReason).toBe(FENCE_REASON.SUPERSEDED_BY_HIGHER_EPOCH);
    expect(readFileSync(successorFile, "utf8")).toBe(successorSnapshot);
    expect(readDoc(lease.file).heartbeat_at_ms).toBe(ownHeartbeatBefore);
  });

  it("HEARTBEAT fornyer faktisk naar vi FORTSATT eier - ellers beviser testen over ingenting", async () => {
    const port = 20909;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeatIntervalMs: 20 });
    const before = readDoc(lease.file).heartbeat_at_ms;
    await new Promise((r) => setTimeout(r, 200));
    expect(readDoc(lease.file).heartbeat_at_ms).toBeGreaterThan(before);
    expect(lease.fenced).toBe(false);
    lease.release();
  });
});

describe("A.3: frigjoering kan ALDRI fjerne eller overskrive en etterfoelger", () => {
  it("release skriver gravstein paa VAAR egen sti - etterfoelgeren staar byte-identisk", () => {
    const port = 20800;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });
    expect(lease.epoch).toBe(1);

    // En etterfoelger dukker opp mens vi er paa vei til aa gi slipp.
    const successorFile = plantLease(leaseDir, port, 2, { owner: someOwner("etterfoelger", 1) });
    const successorSnapshot = readFileSync(successorFile, "utf8");

    lease.release();

    expect(readFileSync(successorFile, "utf8")).toBe(successorSnapshot);
    expect(ownerUuid(successorFile)).toBe("etterfoelger");
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.1.lease`, `${port}.2.lease`]);
  });

  it("en overtakelse som rydder vekk vaar fil: release skriver ingenting, etterfoelgeren staar", () => {
    const port = 20801;
    const lease = acquirePortLease({ leaseDir, window: onePort(port), heartbeat: false });

    const successor = takeOverEpoch({
      leaseDir,
      port,
      inspectedEpoch: lease.epoch,
      inspectedDirId: dirId,
      owner: someOwner("etterfoelger", 1),
      ttlMs: 60_000
    });
    expect(successor.ok).toBe(true);
    if (!successor.ok) return;
    const snapshot = readFileSync(successor.file, "utf8");

    lease.release();

    expect(existsSync(lease.file)).toBe(false);
    expect(readFileSync(successor.file, "utf8")).toBe(snapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.2.lease`]);
  });

  it("release roerer ALDRI vaar egen sti naar den i mellomtiden har faatt en annen eier", () => {
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    writeFileSync(
      lease.file,
      JSON.stringify({ v: 3, port: lease.port, epoch: lease.epoch, dir_id: dirId, state: "held", owner: someOwner("noen-andre"), heartbeat_at_ms: 0, ttl_ms: 1, released_at_ms: null })
    );
    lease.release();
    expect(ownerUuid(lease.file)).toBe("noen-andre");
    expect(readDoc(lease.file).state).toBe("held");
  });

  it("release er idempotent og holder bokfoeringen riktig", () => {
    const start = heldLeaseCount();
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    expect(heldLeaseCount()).toBe(start + 1);
    lease.release();
    lease.release();
    expect(lease.released).toBe(true);
    expect(lease.fenced).toBe(false);
    expect(heldLeaseCount()).toBe(start);
  });
});

describe("A.4: eksklusivitet, eier-identitet, bounded retry og utelukkelse", () => {
  it("to kall om SAMME port gir noeyaktig én eier - og epoken gaar opp etter frigjoering", () => {
    const only = onePort(20500);
    const first = acquirePortLease({ leaseDir, window: only, heartbeat: false });
    expect(first.port).toBe(20500);
    expect(first.epoch).toBe(1);
    expect(() => acquirePortLease({ leaseDir, window: only, isProcessAlive: alive, heartbeat: false })).toThrow(/Feiler lukket/);
    first.release();
    const second = acquirePortLease({ leaseDir, window: only, heartbeat: false });
    expect(second.port).toBe(20500);
    expect(second.epoch).toBe(2);
    second.release();
  });

  it("N kall mot et vindu paa N gir N UNIKE porter, aldri en kollisjon", () => {
    const leases = [0, 1, 2, 3].map(() => acquirePortLease({ leaseDir, window: window4, heartbeat: false }));
    const ports = leases.map((l) => l.port);
    expect(new Set(ports).size).toBe(4);
    expect([...ports].sort()).toEqual([20000, 20001, 20002, 20003]);
    for (const l of leases) l.release();
  });

  it("feiler LUKKET naar vinduet er oppbrukt - returnerer aldri en ubeskyttet port", () => {
    const leases = [0, 1, 2, 3].map(() => acquirePortLease({ leaseDir, window: window4, heartbeat: false }));
    expect(() => acquirePortLease({ leaseDir, window: window4, isProcessAlive: alive, heartbeat: false })).toThrow(
      /Fikk ingen eksklusiv portleie/
    );
    for (const l of leases) l.release();
  });

  it("skriver eksplisitt eier-identitet og fencing-felter, ikke bare en tom markoer", () => {
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    const doc = readDoc(lease.file);
    expect(doc.v).toBe(3);
    expect(doc.port).toBe(lease.port);
    expect(doc.epoch).toBe(lease.epoch);
    expect(doc.state).toBe("held");
    expect(doc.dir_id).toBe(dirId);
    expect(doc.owner.pid).toBe(process.pid);
    expect(doc.owner.host).toBe(hostname());
    expect(doc.owner.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof doc.owner.acquired_at_ms).toBe("number");
    expect(typeof doc.heartbeat_at_ms).toBe("number");
    expect(doc.ttl_ms).toBeGreaterThan(0);
    lease.release();
  });

  it("en UTELUKKET port deles aldri ut - et nytt forsoek gjoer reell framgang", () => {
    const deterministic = { leaseDir, window: window4, heartbeat: false, pickCandidate: (w: CandidateWindow, i: number) => w.low + i };

    const first = acquirePortLease(deterministic);
    expect(first.port).toBe(20000);
    first.release();

    const second = acquirePortLease({ ...deterministic, exclude: [20000] });
    expect(second.port).toBe(20001);
    second.release();

    const third = acquirePortLease({ ...deterministic, exclude: [20000, 20001] });
    expect(third.port).toBe(20002);
    third.release();
  });

  it("naar ALT er utelukket feiler den lukket i stedet for aa gjenbruke en forkastet port", () => {
    expect(() => acquirePortLease({ leaseDir, window: window4, exclude: [20000, 20001, 20002, 20003], heartbeat: false })).toThrow(
      /utelukket av kalleren/
    );
  });
});

describe("A.1/A.2/A.3: EKTE kapploep mellom SEPARATE PROSESSER", () => {
  const modulePath = () => new URL("../src/testing/port-lease.ts", import.meta.url).href;

  /**
   * Barnet tar leien, rapporterer med én gang, og HOLDER den mens soesknene
   * kjemper. Rapporten kommer foer ventingen nettopp fordi foreldreprosessen
   * skal kunne inspisere disken MENS vinneren fortsatt eier leien.
   */
  const childSource = (dir: string, low: number, high: number, holdMs: number, staleAfterMs: number, releaseAtEnd = false) =>
    [
      "const { acquirePortLease } = await import(process.argv[1]);",
      "try {",
      `  const lease = acquirePortLease({ leaseDir: ${JSON.stringify(dir)},`,
      `    window: { low: ${low}, high: ${high}, proven: true, basis: "child" },`,
      `    staleAfterMs: ${staleAfterMs}, isProcessAlive: () => false, heartbeat: false });`,
      "  process.stdout.write('WIN ' + JSON.stringify({ port: lease.port, file: lease.file,",
      "    epoch: lease.epoch, uuid: lease.owner.uuid }) + '\\n');",
      `  await new Promise((r) => setTimeout(r, ${holdMs}));`,
      releaseAtEnd ? "  lease.release();" : "",
      "} catch (err) {",
      "  process.stdout.write('LOSE ' + String(err && err.message).slice(0, 160).replace(/\\s+/g, ' ') + '\\n');",
      "}"
    ]
      .filter(Boolean)
      .join("\n");

  /**
   * Starter et barn og gir tilbake BAADE foerste linje og exit.
   *
   * Skillet er selve poenget: `first` lar oss lese disken mens vinneren
   * fortsatt holder leien, `done` lar oss vente til alle taperne er ute.
   */
  function runChild(dir: string, low: number, high: number, holdMs: number, staleAfterMs: number, releaseAtEnd = false) {
    const proc = spawn(
      process.execPath,
      [
        "--experimental-transform-types",
        "--input-type=module",
        "-e",
        childSource(dir, low, high, holdMs, staleAfterMs, releaseAtEnd),
        modulePath()
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let out = "";
    let err = "";
    let resolveFirst!: (line: string) => void;
    let rejectFirst!: (e: Error) => void;
    const first = new Promise<string>((res, rej) => {
      resolveFirst = res;
      rejectFirst = rej;
    });
    proc.stdout.on("data", (c) => {
      out += String(c);
      const nl = out.indexOf("\n");
      if (nl >= 0) resolveFirst(out.slice(0, nl).trim());
    });
    proc.stderr.on("data", (c) => (err += String(c)));
    proc.on("error", (e) => rejectFirst(e));
    const done = new Promise<void>((resolve, reject) => {
      proc.on("close", (code) => {
        if (code === 0) return resolve();
        rejectFirst(new Error(`exit ${code}: ${err.slice(0, 400)}`));
        reject(new Error(`exit ${code}: ${err.slice(0, 400)}`));
      });
    });
    return { first, done };
  }

  it(
    "GJENTATT kontensjon om ÉN stale leie: noeyaktig én vinner, og vinnerens leie staar etter at alle taperne er ute",
    async () => {
      const CONTENDERS = 8;
      for (let round = 0; round < 3; round++) {
        const dir = mkdtempSync(join(tmpdir(), `jarvis-stale-race-${round}-`));
        const port = 22000 + round;
        try {
          ensureLeaseDirId(dir);
          // Én stale leie alle 8 inspiserer - doed eier, langt eldre enn grensen.
          plantLease(dir, port, 1);

          const children = Array.from({ length: CONTENDERS }, () => runChild(dir, port, port, 4_000, 60_000));
          const lines = await Promise.all(children.map((c) => c.first));

          const wins = lines.filter((l) => l.startsWith("WIN "));
          const losses = lines.filter((l) => l.startsWith("LOSE "));
          expect(wins).toHaveLength(1);
          expect(losses).toHaveLength(CONTENDERS - 1);
          for (const l of losses) expect(l).toMatch(/Fikk ingen eksklusiv portleie/);

          const winner = JSON.parse(wins[0]!.slice(4)) as { port: number; file: string; epoch: number; uuid: string };
          expect(winner.port).toBe(port);
          expect(winner.epoch).toBe(2);

          // Taperne er ute; vinneren holder fortsatt. Leien maa staa, med
          // vinnerens egen eier - og den stale epoken maa vaere ryddet.
          expect(existsSync(winner.file)).toBe(true);
          expect(ownerUuid(winner.file)).toBe(winner.uuid);
          expect(readDoc(winner.file).state).toBe("held");
          expect(leaseNames(dir, port)).toEqual([`${port}.2.lease`]);

          await Promise.all(children.map((c) => c.done));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    300_000
  );

  it(
    "FULLE SYKLUSER paa tvers av PROSESSER: epoken gaar bare oppover, aldri tilbake til 1",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "jarvis-epoch-cycles-"));
      const port = 22500;
      try {
        ensureLeaseDirId(dir);
        const epochs: number[] = [];
        for (let i = 0; i < 6; i++) {
          // Ett barn av gangen: hvert tar leien, gir eksplisitt slipp, og doer.
          // Under D-141 ville hver eneste runde ha faatt generasjon 1.
          const child = runChild(dir, port, port, 10, 60_000, true);
          const line = await child.first;
          expect(line.startsWith("WIN ")).toBe(true);
          epochs.push((JSON.parse(line.slice(4)) as { epoch: number }).epoch);
          await child.done;
        }
        expect(epochs).toEqual([1, 2, 3, 4, 5, 6]);
        expect(highestEpoch(dir, port).epoch).toBe(6);
        expect(leaseNames(dir, port)).toEqual([`${port}.6.lease`]);
        expect(readDoc(join(dir, `${port}.6.lease`)).state).toBe("released");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000
  );

  it(
    "16 SAMTIDIGE prosesser mot 16 porter gir 16 UNIKE porter - gjentatt",
    async () => {
      const CONTENDERS = 16;
      for (let round = 0; round < 3; round++) {
        const dir = mkdtempSync(join(tmpdir(), `jarvis-race-${round}-`));
        const low = 21000 + round * 100;
        const high = low + CONTENDERS - 1;
        try {
          ensureLeaseDirId(dir);
          const children = Array.from({ length: CONTENDERS }, () => runChild(dir, low, high, 1_500, 60_000));
          const lines = await Promise.all(children.map((c) => c.first));
          const ports = lines.map((l) => {
            expect(l.startsWith("WIN ")).toBe(true);
            return (JSON.parse(l.slice(4)) as { port: number }).port;
          });
          expect(ports.every((p) => Number.isInteger(p) && p >= low && p <= high)).toBe(true);
          expect(new Set(ports).size).toBe(CONTENDERS);
          await Promise.all(children.map((c) => c.done));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    },
    300_000
  );

  it(
    "flere samtidige enn det finnes porter: taperne feiler LUKKET, vinnerne er unike",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "jarvis-race-over-"));
      try {
        ensureLeaseDirId(dir);
        const low = 21900;
        const high = 21903; // 4 porter, 10 kandidater
        const children = Array.from({ length: 10 }, () => runChild(dir, low, high, 2_000, 60_000));
        const lines = await Promise.all(children.map((c) => c.first));
        const winners = lines.filter((l) => l.startsWith("WIN ")).map((l) => (JSON.parse(l.slice(4)) as { port: number }).port);
        const losers = lines.filter((l) => l.startsWith("LOSE "));
        expect(winners.length).toBeLessThanOrEqual(4);
        expect(winners.length).toBeGreaterThan(0);
        expect(new Set(winners).size).toBe(winners.length);
        expect(losers.length).toBeGreaterThan(0);
        for (const l of losers) expect(l).toMatch(/Fikk ingen eksklusiv portleie/);
        await Promise.all(children.map((c) => c.done));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    300_000
  );
});
