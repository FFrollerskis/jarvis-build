import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONSERVATIVE_EPHEMERAL_LOW,
  RECLAIM_VERDICT,
  SAFETY_FLOOR,
  acquirePortLease,
  candidateWindow,
  heldLeaseCount,
  highestGeneration,
  readEphemeralRange,
  reclaimVerdict,
  takeOverGeneration,
  type CandidateWindow,
  type EphemeralRangeReading,
  type LeaseDocument,
  type LeaseOwner
} from "../src/testing/index.ts";

/**
 * D-141 A - OBLIGATORISK LEIEBEVIS.
 *
 * D-139 gjorde leien atomisk, men ikke FENCED. Den skrev til én fast sti per
 * port og tok over ved aa `rename`-e stien vekk - en UBETINGET operasjon som
 * flytter det som ligger der naa, ikke det kalleren inspiserte. Derav ABA:
 *
 *     P1 leser leien L      -> vurderer den stale
 *     P2 leser leien L      -> vurderer den stale, tar over, skriver etterfoelger S
 *     P1 rename-r stien     -> river vekk S, en leie P1 aldri saa
 *
 * I tillegg tok D-139 over enhver leie fra en annen vert fordi pid-en "ikke
 * betyr noe der" - en fail-OPEN antakelse som stjeler fra en levende eier.
 *
 * Denne suiten beviser at begge er lukket: overtakelse er betinget av den
 * EKSAKTE generasjonen som ble inspisert, frigjoering kan ikke naa en
 * etterfoelger, og en kryssvert-leie tas aldri over uten verifiserbar
 * fencing-sannhet.
 */

let leaseDir: string;

beforeEach(() => {
  leaseDir = mkdtempSync(join(tmpdir(), "jarvis-lease-test-"));
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
}

/** Legger en leie paa disk slik en annen prosess ville gjort det. */
function plantLease(dir: string, port: number, generation: number, over: PlantOverrides = {}): string {
  const doc: LeaseDocument = {
    v: 2,
    port,
    generation,
    owner: over.owner ?? { pid: 999_999, uuid: "planted-" + generation, host: hostname(), acquired_at_ms: 0 },
    heartbeat_at_ms: over.heartbeat_at_ms ?? 0,
    ttl_ms: over.ttl_ms ?? 60_000
  };
  const file = join(dir, `${port}.${generation}.lease`);
  writeFileSync(file, JSON.stringify(doc, null, 2));
  return file;
}

function leaseNames(dir: string, port: number): string[] {
  return readdirSync(dir)
    .filter((n) => n.startsWith(`${port}.`))
    .sort();
}

function ownerUuid(file: string): string {
  return (JSON.parse(readFileSync(file, "utf8")) as LeaseDocument).owner.uuid;
}

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

describe("A.1: overtakelse er BETINGET av den generasjonen kalleren inspiserte", () => {
  it("en ledig port gir generasjon 1, og generasjonen ligger i filnavnet", () => {
    const lease = acquirePortLease({ leaseDir, window: onePort(20400), heartbeat: false });
    expect(lease.generation).toBe(1);
    expect(lease.file).toBe(join(leaseDir, "20400.1.lease"));
    expect(highestGeneration(leaseDir, 20400)).toEqual({ generation: 1, file: lease.file });
    lease.release();
  });

  it("DETERMINISTISK ABA: en etterfoelger opprettes foer den tapende reclaimeren handler", () => {
    const port = 20700;
    // Den stale leien BEGGE inspiserer.
    plantLease(leaseDir, port, 1);
    expect(highestGeneration(leaseDir, port).generation).toBe(1);

    // P2 rekker foerst og oppretter etterfoelgeren.
    const successor = takeOverGeneration({
      leaseDir,
      port,
      inspectedGeneration: 1,
      owner: { pid: process.pid, uuid: "etterfoelger", host: hostname(), acquired_at_ms: 1_000 },
      ttlMs: 60_000
    });
    expect(successor?.generation).toBe(2);
    const snapshot = readFileSync(successor!.file, "utf8");

    // P1 handler NAA paa sin foreldede lesning av generasjon 1. Under D-139 var
    // dette et ubetinget `rename` som rev vekk S. Naa er det et `wx`-forsoek paa
    // en generasjon som allerede finnes.
    const loser = takeOverGeneration({
      leaseDir,
      port,
      inspectedGeneration: 1,
      owner: { pid: process.pid, uuid: "taper", host: hostname(), acquired_at_ms: 2_000 },
      ttlMs: 60_000
    });
    expect(loser).toBeNull();

    // Etterfoelgeren staar BYTE-IDENTISK, og taperen etterlot seg ingenting.
    expect(readFileSync(successor!.file, "utf8")).toBe(snapshot);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.2.lease`]);
  });

  it("bare EN av mange samtidige overtakere av samme generasjon lykkes", () => {
    const port = 20701;
    plantLease(leaseDir, port, 3);
    const results = [0, 1, 2, 3, 4, 5].map((i) =>
      takeOverGeneration({
        leaseDir,
        port,
        inspectedGeneration: 3,
        owner: { pid: process.pid, uuid: "kandidat-" + i, host: hostname(), acquired_at_ms: i },
        ttlMs: 60_000
      })
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.4.lease`]);
  });

  it("opprydding fjerner KUN strengt lavere generasjoner", () => {
    const port = 20702;
    plantLease(leaseDir, port, 1);
    plantLease(leaseDir, port, 2);
    const taken = takeOverGeneration({
      leaseDir,
      port,
      inspectedGeneration: 2,
      owner: { pid: process.pid, uuid: "ny", host: hostname(), acquired_at_ms: 0 },
      ttlMs: 60_000
    });
    expect(taken?.generation).toBe(3);
    expect(leaseNames(leaseDir, port)).toEqual([`${port}.3.lease`]);
  });
});

describe("A.2: hvem som lever - og hva vi gjoer naar vi ikke vet", () => {
  const doc = (over: { heartbeat_at_ms?: number; ttl_ms?: number; host?: string } = {}): LeaseDocument => ({
    v: 2,
    port: 1234,
    generation: 1,
    heartbeat_at_ms: over.heartbeat_at_ms ?? 0,
    ttl_ms: over.ttl_ms ?? 60_000,
    owner: { pid: 4242, uuid: "u", host: over.host ?? hostname(), acquired_at_ms: 0 }
  });

  const ctx = (over: { isProcessAlive?: (pid: number) => boolean } = {}) => ({
    now: 10_000_000,
    staleAfterMs: 1_000,
    hostId: hostname(),
    isProcessAlive: over.isProcessAlive ?? dead
  });

  it("samme vert, eieren LEVER: aldri, uansett alder", () => {
    expect(reclaimVerdict(doc(), ctx({ isProcessAlive: alive }))).toBe(RECLAIM_VERDICT.HELD_LOCAL_OWNER_ALIVE);
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
    // Noeyaktig D-139-defekten: pid-en kan ikke sjekkes her, saa leien ble tatt.
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
    expect(taken.generation).toBe(2);
    expect(ownerUuid(taken.file)).not.toBe("gammel");
    taken.release();

    const liveFile = plantLease(leaseDir, port, 5, { owner: { pid: 4242, uuid: "levende", host: hostname(), acquired_at_ms: 0 } });
    expect(() =>
      acquirePortLease({ leaseDir, window: onePort(port), staleAfterMs: 1_000, now: () => 1_000_000, isProcessAlive: alive, heartbeat: false })
    ).toThrow(/Fikk ingen eksklusiv portleie/);
    expect(ownerUuid(liveFile)).toBe("levende");
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

  it("ende-til-ende: en KRYSSVERT-leie med UTLOEPT heartbeat kan tas over", () => {
    const port = 20603;
    plantLease(leaseDir, port, 1, {
      heartbeat_at_ms: 1_000,
      ttl_ms: 1_000,
      owner: { pid: 4242, uuid: "fjern-og-forlatt", host: "en-annen-maskin", acquired_at_ms: 0 }
    });
    const lease = acquirePortLease({ leaseDir, window: onePort(port), now: () => 1_000_000, isProcessAlive: alive, heartbeat: false });
    expect(lease.generation).toBe(2);
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
});

describe("A.3: frigjoering kan ALDRI fjerne en etterfoelger", () => {
  it("release fjerner vaar EGEN generasjon", () => {
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    expect(leaseNames(leaseDir, lease.port)).toEqual([`${lease.port}.1.lease`]);
    lease.release();
    expect(leaseNames(leaseDir, lease.port)).toEqual([]);
  });

  it("release kappes mot en overtakelse: etterfoelgeren staar uroert", () => {
    const lease = acquirePortLease({ leaseDir, window: onePort(20800), heartbeat: false });
    expect(lease.generation).toBe(1);

    // Noen tar over mens vi er paa vei til aa gi slipp.
    const successor = takeOverGeneration({
      leaseDir,
      port: lease.port,
      inspectedGeneration: lease.generation,
      owner: { pid: process.pid, uuid: "etterfoelger", host: hostname(), acquired_at_ms: 1 },
      ttlMs: 60_000
    })!;
    expect(successor.generation).toBe(2);

    lease.release();

    // Etterfoelgeren finnes fortsatt, og er fortsatt DERES.
    expect(existsSync(successor.file)).toBe(true);
    expect(ownerUuid(successor.file)).toBe("etterfoelger");
    expect(leaseNames(leaseDir, lease.port)).toEqual([`${lease.port}.2.lease`]);
  });

  it("release roerer ALDRI vaar egen sti naar den i mellomtiden har faatt en annen eier", () => {
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    writeFileSync(
      lease.file,
      JSON.stringify({ v: 2, port: lease.port, generation: lease.generation, owner: { pid: 1, uuid: "noen-andre", host: hostname(), acquired_at_ms: 0 }, heartbeat_at_ms: 0, ttl_ms: 1 })
    );
    lease.release();
    expect(ownerUuid(lease.file)).toBe("noen-andre");
    rmSync(lease.file, { force: true });
  });

  it("release er idempotent og holder bokfoeringen riktig", () => {
    const start = heldLeaseCount();
    const lease = acquirePortLease({ leaseDir, window: window4, heartbeat: false });
    expect(heldLeaseCount()).toBe(start + 1);
    lease.release();
    lease.release();
    expect(lease.released).toBe(true);
    expect(heldLeaseCount()).toBe(start);
  });
});

describe("A.4: eksklusivitet, eier-identitet, bounded retry og utelukkelse", () => {
  it("to kall om SAMME port gir noeyaktig én eier", () => {
    const only = onePort(20500);
    const first = acquirePortLease({ leaseDir, window: only, heartbeat: false });
    expect(first.port).toBe(20500);
    expect(() => acquirePortLease({ leaseDir, window: only, isProcessAlive: alive, heartbeat: false })).toThrow(/Feiler lukket/);
    first.release();
    const second = acquirePortLease({ leaseDir, window: only, heartbeat: false });
    expect(second.port).toBe(20500);
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
    const doc = JSON.parse(readFileSync(lease.file, "utf8")) as LeaseDocument;
    expect(doc.v).toBe(2);
    expect(doc.port).toBe(lease.port);
    expect(doc.generation).toBe(lease.generation);
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
  const childSource = (dir: string, low: number, high: number, holdMs: number, staleAfterMs: number) =>
    [
      "const { acquirePortLease } = await import(process.argv[1]);",
      "try {",
      `  const lease = acquirePortLease({ leaseDir: ${JSON.stringify(dir)},`,
      `    window: { low: ${low}, high: ${high}, proven: true, basis: "child" },`,
      `    staleAfterMs: ${staleAfterMs}, isProcessAlive: () => false, heartbeat: false });`,
      "  process.stdout.write('WIN ' + JSON.stringify({ port: lease.port, file: lease.file,",
      "    generation: lease.generation, uuid: lease.owner.uuid }) + '\\n');",
      `  await new Promise((r) => setTimeout(r, ${holdMs}));`,
      "} catch (err) {",
      "  process.stdout.write('LOSE ' + String(err && err.message).slice(0, 160).replace(/\\s+/g, ' ') + '\\n');",
      "}"
    ].join("\n");

  /**
   * Starter et barn og gir tilbake BAADE foerste linje og exit.
   *
   * Skillet er selve poenget: `first` lar oss lese disken mens vinneren
   * fortsatt holder leien, `done` lar oss vente til alle taperne er ute.
   */
  function runChild(dir: string, low: number, high: number, holdMs: number, staleAfterMs: number) {
    const proc = spawn(
      process.execPath,
      ["--experimental-transform-types", "--input-type=module", "-e", childSource(dir, low, high, holdMs, staleAfterMs), modulePath()],
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
          // Én stale leie alle 8 inspiserer - doed eier, langt eldre enn grensen.
          plantLease(dir, port, 1);

          const children = Array.from({ length: CONTENDERS }, () => runChild(dir, port, port, 4_000, 60_000));
          const lines = await Promise.all(children.map((c) => c.first));

          const wins = lines.filter((l) => l.startsWith("WIN "));
          const losses = lines.filter((l) => l.startsWith("LOSE "));
          expect(wins).toHaveLength(1);
          expect(losses).toHaveLength(CONTENDERS - 1);
          for (const l of losses) expect(l).toMatch(/Fikk ingen eksklusiv portleie/);

          const winner = JSON.parse(wins[0]!.slice(4)) as { port: number; file: string; generation: number; uuid: string };
          expect(winner.port).toBe(port);
          expect(winner.generation).toBe(2);

          // Taperne er ute; vinneren holder fortsatt. Leien maa staa, med
          // vinnerens egen eier - og den stale generasjonen maa vaere ryddet.
          expect(existsSync(winner.file)).toBe(true);
          expect(ownerUuid(winner.file)).toBe(winner.uuid);
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
    "16 SAMTIDIGE prosesser mot 16 porter gir 16 UNIKE porter - gjentatt",
    async () => {
      const CONTENDERS = 16;
      for (let round = 0; round < 3; round++) {
        const dir = mkdtempSync(join(tmpdir(), `jarvis-race-${round}-`));
        const low = 21000 + round * 100;
        const high = low + CONTENDERS - 1;
        try {
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
