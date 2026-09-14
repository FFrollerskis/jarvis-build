import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONSERVATIVE_EPHEMERAL_LOW,
  SAFETY_FLOOR,
  acquirePortLease,
  candidateWindow,
  heldLeaseCount,
  isReclaimable,
  readEphemeralRange,
  type CandidateWindow,
  type EphemeralRangeReading
} from "../src/testing/index.ts";

/**
 * D-139 A - OBLIGATORISK PORTBEVIS.
 *
 * D-137 erstattet ett gjett med et annet: `Math.random()` i et "trygt"
 * intervall, uten noen eksklusivitet og med en stille substitusjon av 32768
 * naar kjernens efemere intervall ikke kunne leses. Denne suiten beviser at
 * begge delene er borte - at leien faktisk er eksklusiv paa tvers av prosesser,
 * at stale-overtakelse er tidsavgrenset og aldri kan stjele en levende leie, og
 * at range-logikken skiller LEST fra ANTATT i stedet for aa paastaa et default.
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

describe("A.3: det efemere intervallet leses - det antas aldri", () => {
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

describe("A.3: kandidatvinduet - bevist disjunkt, eller aerlig merket som antatt", () => {
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
    expect(w.low).toBeGreaterThan(50000);
    // Det avgjoerende: vi havnet IKKE i det gamle 32768-omraadet, som ligger
    // midt inne i det leste intervallet.
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

describe("A.2: leien er EKSKLUSIV - to kandidater, én vinner", () => {
  it("to kall om SAMME port gir noeyaktig én eier", () => {
    const only: CandidateWindow = { low: 20500, high: 20500, proven: true, basis: "test" };
    const first = acquirePortLease({ leaseDir, window: only });
    expect(first.port).toBe(20500);
    expect(() => acquirePortLease({ leaseDir, window: only, isProcessAlive: alive })).toThrow(/Feiler lukket/);
    first.release();
    // Naar vinneren har gitt slipp, kan neste faktisk faa den.
    const second = acquirePortLease({ leaseDir, window: only });
    expect(second.port).toBe(20500);
    second.release();
  });

  it("N kall mot et vindu paa N gir N UNIKE porter, aldri en kollisjon", () => {
    const leases = [0, 1, 2, 3].map(() => acquirePortLease({ leaseDir, window: window4 }));
    const ports = leases.map((l) => l.port);
    expect(new Set(ports).size).toBe(4);
    expect([...ports].sort()).toEqual([20000, 20001, 20002, 20003]);
    for (const l of leases) l.release();
  });

  it("feiler LUKKET naar vinduet er oppbrukt - returnerer aldri en ubeskyttet port", () => {
    const leases = [0, 1, 2, 3].map(() => acquirePortLease({ leaseDir, window: window4 }));
    expect(() => acquirePortLease({ leaseDir, window: window4, isProcessAlive: alive })).toThrow(
      /Fikk ingen eksklusiv portleie/
    );
    for (const l of leases) l.release();
  });

  it("skriver eksplisitt eier-identitet, ikke bare en tom markoer", () => {
    const lease = acquirePortLease({ leaseDir, window: window4 });
    const doc = JSON.parse(readFileSync(lease.file, "utf8")) as { port: number; owner: Record<string, unknown> };
    expect(doc.port).toBe(lease.port);
    expect(doc.owner["pid"]).toBe(process.pid);
    expect(doc.owner["host"]).toBe(hostname());
    expect(String(doc.owner["uuid"])).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof doc.owner["acquired_at_ms"]).toBe("number");
    lease.release();
  });
});

describe("A.2: stale recovery er tidsavgrenset og kan ALDRI stjele en levende leie", () => {
  const owner = (over: Partial<{ pid: number; host: string; acquired_at_ms: number }> = {}) => ({
    owner: { pid: 4242, uuid: "u", host: hostname(), acquired_at_ms: 0, ...over }
  });

  it("en FERSK leie er aldri stale, selv om eieren er doed", () => {
    expect(isReclaimable(owner({ acquired_at_ms: 1000 }), { now: 1500, staleAfterMs: 1000, isProcessAlive: dead })).toBe(false);
  });

  it("en GAMMEL leie med LEVENDE eier tas aldri over", () => {
    expect(isReclaimable(owner({ acquired_at_ms: 0 }), { now: 10_000, staleAfterMs: 1000, isProcessAlive: alive })).toBe(false);
  });

  it("en GAMMEL leie med DOED eier kan tas over", () => {
    expect(isReclaimable(owner({ acquired_at_ms: 0 }), { now: 10_000, staleAfterMs: 1000, isProcessAlive: dead })).toBe(true);
  });

  it("en leie fra en ANNEN maskin kan tas over - lokal pid betyr ingenting der", () => {
    expect(
      isReclaimable(owner({ acquired_at_ms: 0, host: "en-annen-maskin" }), { now: 10_000, staleAfterMs: 1000, isProcessAlive: alive })
    ).toBe(true);
  });

  it("en ULESELIG leiefil er ALDRI stale - vi vet ikke hvem som eier den", () => {
    expect(isReclaimable(null, { now: 10_000, staleAfterMs: 1000, isProcessAlive: dead })).toBe(false);
    expect(isReclaimable({}, { now: 10_000, staleAfterMs: 1000, isProcessAlive: dead })).toBe(false);
  });

  it("ende-til-ende: en gammel, doed leie gjenbrukes; en gammel, LEVENDE gjoer det ikke", () => {
    const only: CandidateWindow = { low: 20600, high: 20600, proven: true, basis: "test" };
    const file = join(leaseDir, "20600.lease");

    writeFileSync(file, JSON.stringify({ v: 1, port: 20600, owner: { pid: 999999, uuid: "gammel", host: hostname(), acquired_at_ms: 0 } }));
    const taken = acquirePortLease({ leaseDir, window: only, staleAfterMs: 1, now: () => 1_000_000, isProcessAlive: dead });
    expect(taken.port).toBe(20600);
    expect(JSON.parse(readFileSync(file, "utf8")).owner.uuid).not.toBe("gammel");
    taken.release();

    writeFileSync(file, JSON.stringify({ v: 1, port: 20600, owner: { pid: 4242, uuid: "levende", host: hostname(), acquired_at_ms: 0 } }));
    expect(() =>
      acquirePortLease({ leaseDir, window: only, staleAfterMs: 1, now: () => 1_000_000, isProcessAlive: alive })
    ).toThrow(/Fikk ingen eksklusiv portleie/);
    // Den levende leien staar uroert - vi rev den ikke vekk.
    expect(JSON.parse(readFileSync(file, "utf8")).owner.uuid).toBe("levende");
  });
});

describe("A.2: opprydding frigjoer KUN kallerens egen leie", () => {
  it("release fjerner vaar egen leiefil", () => {
    const lease = acquirePortLease({ leaseDir, window: window4 });
    expect(readdirSync(leaseDir)).toContain(`${lease.port}.lease`);
    lease.release();
    expect(readdirSync(leaseDir)).not.toContain(`${lease.port}.lease`);
  });

  it("release roerer ALDRI en leie som i mellomtiden har faatt en annen eier", () => {
    const lease = acquirePortLease({ leaseDir, window: window4 });
    writeFileSync(lease.file, JSON.stringify({ v: 1, port: lease.port, owner: { pid: 1, uuid: "noen-andre", host: hostname(), acquired_at_ms: 0 } }));
    lease.release();
    const after = JSON.parse(readFileSync(lease.file, "utf8")) as { owner: { uuid: string } };
    expect(after.owner.uuid).toBe("noen-andre");
    rmSync(lease.file, { force: true });
  });

  it("release er idempotent og holder bokfoeringen riktig", () => {
    const start = heldLeaseCount();
    const lease = acquirePortLease({ leaseDir, window: window4 });
    expect(heldLeaseCount()).toBe(start + 1);
    lease.release();
    lease.release();
    expect(lease.released).toBe(true);
    expect(heldLeaseCount()).toBe(start);
  });
});

describe("A.1/A.2: EKTE kapploep mellom SEPARATE PROSESSER", () => {
  /**
   * Det avgjoerende beviset. `Math.random()` ville her produsert kollisjoner;
   * leien kan per konstruksjon ikke gjoere det, fordi `openSync(.., "wx")`
   * lykkes for noeyaktig én prosess.
   */
  /**
   * Barnet tar leien, skriver porten, og HOLDER den mens soesknene kjemper om
   * de samme portene. Ventingen er selve poenget: uten den ville prosessene
   * kunne kjoert etter hverandre og lovlig gjenbrukt samme port, og testen
   * ville bevist ingenting.
   */
  const childSource = (dir: string, low: number, high: number) =>
    [
      "const { acquirePortLease } = await import(process.argv[1]);",
      `const lease = acquirePortLease({ leaseDir: ${JSON.stringify(dir)},`,
      ` window: { low: ${low}, high: ${high}, proven: true, basis: "child" } });`,
      "process.stdout.write(String(lease.port));",
      "await new Promise((r) => setTimeout(r, 1500));"
    ].join("");

  function runChild(modulePath: string, dir: string, low: number, high: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        ["--experimental-transform-types", "--input-type=module", "-e", childSource(dir, low, high), modulePath],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      let out = "";
      let err = "";
      proc.stdout.on("data", (c) => (out += String(c)));
      proc.stderr.on("data", (c) => (err += String(c)));
      proc.on("error", reject);
      proc.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}: ${err.slice(0, 400)}`))));
    });
  }

  it("16 SAMTIDIGE prosesser mot 16 porter gir 16 UNIKE porter - gjentatt", async () => {
    const modulePath = new URL("../src/testing/port-lease.ts", import.meta.url).href;
    const CONTENDERS = 16;

    // Gjentas for aa eksponere sannsynlighetsbaserte kapploep, ikke bare ett heldig treff.
    for (let round = 0; round < 3; round++) {
      const dir = mkdtempSync(join(tmpdir(), `jarvis-race-${round}-`));
      const low = 21000 + round * 100;
      const high = low + CONTENDERS - 1;
      try {
        // Alle startes FOER vi venter paa noen - ekte samtidighet, ikke en koe.
        const pending = Array.from({ length: CONTENDERS }, () => runChild(modulePath, dir, low, high));
        const results = await Promise.all(pending);
        const ports = results.map((r) => Number.parseInt(r, 10));
        expect(ports.every((p) => Number.isInteger(p) && p >= low && p <= high)).toBe(true);
        expect(new Set(ports).size).toBe(CONTENDERS);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 300_000);

  it("flere samtidige enn det finnes porter: taperne feiler LUKKET, vinnerne er unike", async () => {
    const modulePath = new URL("../src/testing/port-lease.ts", import.meta.url).href;
    const dir = mkdtempSync(join(tmpdir(), "jarvis-race-over-"));
    try {
      const low = 21900;
      const high = 21903; // 4 porter, 10 kandidater
      const settled = await Promise.allSettled(Array.from({ length: 10 }, () => runChild(modulePath, dir, low, high)));
      const winners = settled.filter((s) => s.status === "fulfilled").map((s) => Number.parseInt((s as PromiseFulfilledResult<string>).value, 10));
      const losers = settled.filter((s) => s.status === "rejected");
      expect(winners.length).toBeLessThanOrEqual(4);
      expect(new Set(winners).size).toBe(winners.length); // ingen kollisjon blant vinnerne
      expect(losers.length).toBeGreaterThan(0);
      for (const l of losers) {
        expect(String((l as PromiseRejectedResult).reason)).toMatch(/Fikk ingen eksklusiv portleie/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
