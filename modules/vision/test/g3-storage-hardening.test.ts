import { randomUUID } from "node:crypto";
import { lstat, lutimes, mkdir, mkdtemp, readdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter, type StorageAdapter } from "../src/storage.ts";

/**
 * WP-G3 (D-465), mini-fiks-runden (review delta B LOW-D3/LOW-D4): lagringsadapteren tåler samtidige sletteverk og krasj midt i en skriving.
 *  - `delete`: ENOENT fra `unlink` (en annen reaper vant kappløpet mellom `lstat` og `unlink`) er `{ existed: false }`, ikke en feil (114 falske `failed` i samtidighetsprøven). Enhver ANNEN feil kastes fortsatt.
 *  - `put`: feiler selve skrivingen (full disk), ryddes temp-filen bort (tidligere ble den stående).
 *  - `purgeStaleTemp`: foreldreløse `<nøkkel>.tmp-<uuid>` (krasj mellom skriving og rename; ingen rad og ingen gravstein peker på dem) fjernes når de er eldre enn en grense - og INGENTING annet.
 *  - rotmappen opprettes med 0700 (kun tjenestebrukeren).
 */
const BYTES = new Uint8Array([1, 2, 3, 4]);
const fsError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });
const tmpName = (key: string): string => `${key}.tmp-${randomUUID()}`;
const HOURS = 3_600_000;

async function freshRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "jarvis-vision-storage-hardening-"));
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isFile() || e.isSymbolicLink()).map((e) => join(e.parentPath, e.name)).sort();
}

async function age(path: string, hours: number): Promise<void> {
  const when = new Date(Date.now() - hours * HOURS);
  await utimes(path, when, when);
}

describe("delete: et kappløp mot en annen reaper er ikke en feil (review delta B LOW-D3)", () => {
  it("ENOENT fra unlink (filen var borte mellom lstat og unlink) gir { existed: false } - ikke et kast", async () => {
    const root = await freshRoot();
    const adapter = new LocalFsStorageAdapter(root, {
      unlink: async (path) => {
        await unlink(path); // «den andre reaperen» slettet filen først ...
        throw fsError("ENOENT"); // ... så vår egen unlink fant den ikke
      }
    });
    await adapter.put("snapshots/aa/race", BYTES);
    await expect(adapter.delete("snapshots/aa/race")).resolves.toEqual({ existed: false });
    expect(await filesUnder(root)).toEqual([]);
  });

  it("enhver ANNEN unlink-feil (EPERM, EISDIR, EIO ...) kastes fortsatt: reaperen skal beholde graven og prøve igjen", async () => {
    const root = await freshRoot();
    for (const code of ["EPERM", "EISDIR", "EIO", "EACCES"]) {
      const adapter = new LocalFsStorageAdapter(root, { unlink: async () => { throw fsError(code); } });
      await adapter.put(`snapshots/aa/keep-${code}`, BYTES);
      await expect(adapter.delete(`snapshots/aa/keep-${code}`), code).rejects.toMatchObject({ code });
      expect(await new LocalFsStorageAdapter(root).exists(`snapshots/aa/keep-${code}`), `${code}: filen står`).toBe(true);
    }
  });

  it("vanlig sletting er uendret: eksisterende fil gir existed: true, og en fil som aldri fantes gir existed: false", async () => {
    const adapter = new LocalFsStorageAdapter(await freshRoot());
    await adapter.put("snapshots/aa/plain", BYTES);
    await expect(adapter.delete("snapshots/aa/plain")).resolves.toEqual({ existed: true });
    await expect(adapter.delete("snapshots/aa/plain")).resolves.toEqual({ existed: false });
    await expect(adapter.delete("snapshots/aa/never")).resolves.toEqual({ existed: false });
  });

  it("30 samtidige slettinger av samme nøkkel: ingen feiler, nøyaktig de som faktisk fjernet filen melder existed: true (minst én)", async () => {
    const adapter = new LocalFsStorageAdapter(await freshRoot());
    for (let round = 0; round < 5; round += 1) {
      const key = `snapshots/aa/concurrent-${round}`;
      await adapter.put(key, BYTES);
      const results = await Promise.allSettled(Array.from({ length: 30 }, () => adapter.delete(key)));
      expect(results.filter((r) => r.status === "rejected")).toEqual([]);
      expect(results.filter((r) => r.status === "fulfilled" && r.value.existed).length).toBeGreaterThanOrEqual(1);
      expect(await adapter.exists(key)).toBe(false);
    }
  });
});

describe("put: en mislykket skriving etterlater ingen temp-fil (review delta B LOW-D4)", () => {
  it("full disk midt i skrivingen (halvskrevet temp-fil + ENOSPC): temp-filen ryddes, nøkkelen finnes ikke, feilen kastes videre", async () => {
    const root = await freshRoot();
    const adapter = new LocalFsStorageAdapter(root, {
      writeFile: async (path, data, options) => {
        await writeFile(path, (data as Uint8Array).subarray(0, 2), options as never); // halvskrevet
        throw fsError("ENOSPC");
      }
    });
    await expect(adapter.put("snapshots/aa/full-disk", BYTES)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(await filesUnder(root)).toEqual([]);
    expect(await new LocalFsStorageAdapter(root).exists("snapshots/aa/full-disk")).toBe(false);
  });

  it("rename feiler (EXDEV): temp-filen ryddes (uendret oppførsel), og en vellykket put etterlater kun selve objektet", async () => {
    const root = await freshRoot();
    const failing = new LocalFsStorageAdapter(root, { rename: async () => { throw fsError("EXDEV"); } });
    await expect(failing.put("snapshots/aa/rename-fails", BYTES)).rejects.toMatchObject({ code: "EXDEV" });
    expect(await filesUnder(root)).toEqual([]);
    const adapter = new LocalFsStorageAdapter(root);
    await adapter.put("snapshots/aa/ok", BYTES);
    expect((await filesUnder(root)).map((p) => p.slice(root.length))).toEqual(["/snapshots/aa/ok"]);
    expect(Array.from((await adapter.get("snapshots/aa/ok")) as Uint8Array)).toEqual(Array.from(BYTES));
  });
});

describe("purgeStaleTemp: foreldreløse temp-filer (ingen rad, ingen gravstein) ryddes - og ingenting annet", () => {
  async function seed(): Promise<{ root: string; adapter: LocalFsStorageAdapter; oldTemp: string; oldTemp2: string; freshTemp: string; recentTemp: string; finalFile: string; lookalike: string; linkTemp: string; dirTemp: string; outside: string }> {
    const root = await freshRoot();
    const adapter = new LocalFsStorageAdapter(root);
    const dir = join(root, "snapshots", "aa");
    await mkdir(dir, { recursive: true });
    const make = async (name: string, hours: number): Promise<string> => {
      const path = join(dir, name);
      await writeFile(path, BYTES);
      await age(path, hours);
      return path;
    };
    const oldTemp = await make(tmpName("snap-1"), 48);
    const oldTemp2 = await make(tmpName("snap-2"), 12);
    const freshTemp = await make(tmpName("snap-3"), 0);
    const recentTemp = await make(tmpName("snap-3b"), 1); // 1 time: yngre enn grensen på 6 t, så den kan være en treg skriving og står
    const finalFile = await make("snap-final", 200); // gammel, men et ekte objekt: aldri rørt
    const lookalike = await make("snap-4.tmp-not-a-uuid", 100);
    const outside = join(root, "..", `outside-${randomUUID()}`);
    await writeFile(outside, BYTES);
    await age(outside, 100);
    // Symlenken og katalogen er GAMLE og heter som en temp-fil: det er KUN typen (ikke alderen) som skal berge dem.
    const longAgo = new Date(Date.now() - 100 * HOURS);
    const linkTemp = join(dir, tmpName("snap-link"));
    await symlink(outside, linkTemp);
    await lutimes(linkTemp, longAgo, longAgo);
    const dirTemp = join(dir, tmpName("snap-dir"));
    await mkdir(dirTemp);
    await age(dirTemp, 100);
    return { root, adapter, oldTemp, oldTemp2, freshTemp, recentTemp, finalFile, lookalike, linkTemp, dirTemp, outside };
  }
  const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null;

  it("fjerner KUN vanlige filer som heter `<nøkkel>.tmp-<uuid>` og er eldre enn grensen; en fersk temp (kan være en skriving som pågår), et ekte objekt, et navn som bare ligner, en symlenke og en katalog står", async () => {
    const s = await seed();
    const result = await s.adapter.purgeStaleTemp(6 * HOURS);
    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(await exists(s.oldTemp)).toBe(false);
    expect(await exists(s.oldTemp2)).toBe(false);
    for (const kept of [s.freshTemp, s.recentTemp, s.finalFile, s.lookalike, s.linkTemp, s.dirTemp, s.outside]) expect(await exists(kept), kept).toBe(true);
    expect((await stat(s.outside)).size).toBe(BYTES.length); // lenkemålet er urørt (lenker følges aldri)
    // idempotent: ingenting mer å rydde
    await expect(s.adapter.purgeStaleTemp(6 * HOURS)).resolves.toEqual({ removed: 0, failed: 0 });
  });

  it("grensen er parameteren: en temp som er 12 timer gammel ryddes med 6 t-grense men ikke med 24 t-grense", async () => {
    const s = await seed();
    await expect(s.adapter.purgeStaleTemp(24 * HOURS)).resolves.toEqual({ removed: 1, failed: 0 }); // kun den på 48 t
    expect(await exists(s.oldTemp2)).toBe(true);
    await expect(s.adapter.purgeStaleTemp(6 * HOURS)).resolves.toEqual({ removed: 1, failed: 0 });
    expect(await exists(s.oldTemp2)).toBe(false);
  });

  it("en fil som ikke lar seg slette telles som failed (ingen kast, resten ryddes likevel); en rotmappe som ikke finnes gir {0, 0}", async () => {
    const s = await seed();
    const blocked = new LocalFsStorageAdapter(s.root, { unlink: async (path) => { if (String(path) === s.oldTemp) throw fsError("EPERM"); await unlink(path); } });
    await expect(blocked.purgeStaleTemp(6 * HOURS)).resolves.toEqual({ removed: 1, failed: 1 });
    expect(await exists(s.oldTemp)).toBe(true);
    expect(await exists(s.oldTemp2)).toBe(false);
    const missing = new LocalFsStorageAdapter(join(await freshRoot(), "finnes-ikke"));
    await expect(missing.purgeStaleTemp(HOURS)).resolves.toEqual({ removed: 0, failed: 0 });
  });

  it("ugyldig grense (negativ, NaN, uendelig) avvises - en feilkonfigurert grense kan aldri rydde bort ferske filer", async () => {
    const s = await seed();
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0, 30_000]) await expect(s.adapter.purgeStaleTemp(bad), String(bad)).rejects.toThrow("storage_purge_age_invalid"); // under ett minutt kunne slettet en skriving som pågår
    expect(await exists(s.freshTemp)).toBe(true);
    expect(await exists(s.oldTemp)).toBe(true);
  });
});

describe("rotmappen opprettes med 0700 (review delta B LOW-D4)", () => {
  it("første put i en rotmappe som ikke finnes oppretter rot og undermapper kun for tjenestebrukeren (0700), og objektet er 0600", async () => {
    if (process.platform === "win32") return;
    const parent = await freshRoot();
    const root = join(parent, "vision-data");
    await new LocalFsStorageAdapter(root).put("snapshots/aa/mode", BYTES);
    for (const dir of [root, join(root, "snapshots"), join(root, "snapshots", "aa")]) expect((await stat(dir)).mode & 0o777, dir).toBe(0o700);
    expect((await stat(join(root, "snapshots", "aa", "mode"))).mode & 0o777).toBe(0o600);
  });
});

describe("VisionSnapshotService.purgeStaleTempFiles: delegerer til adapteren, og tåler en adapter uten støtte", () => {
  const service = (storage: StorageAdapter): VisionSnapshotService => new VisionSnapshotService(null as never, storage, null as never);

  it("gir adapterens tall videre, og {0, 0} for en adapter som ikke har noen temp-filer å rydde", async () => {
    const root = await freshRoot();
    const adapter = new LocalFsStorageAdapter(root);
    const dir = join(root, "snapshots", "aa");
    await mkdir(dir, { recursive: true });
    const orphan = join(dir, tmpName("orphan"));
    await writeFile(orphan, BYTES);
    await age(orphan, 30);
    await expect(service(adapter).purgeStaleTempFiles(6 * HOURS)).resolves.toEqual({ removed: 1, failed: 0 });
    const noSupport: StorageAdapter = { backend: "other", put: async () => undefined, get: async () => null, delete: async () => ({ existed: false }), exists: async () => false };
    await expect(service(noSupport).purgeStaleTempFiles(6 * HOURS)).resolves.toEqual({ removed: 0, failed: 0 });
  });
});
