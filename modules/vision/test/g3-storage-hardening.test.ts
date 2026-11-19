import { randomUUID } from "node:crypto";
import { chmod, lstat, lutimes, mkdir, mkdtemp, readdir, stat, symlink, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SNAPSHOT_KEY_PREFIX, VisionSnapshotService } from "../src/snapshots.ts";
import { LocalFsStorageAdapter, StorageKeyError, type PurgeStaleTempOptions, type StorageAdapter } from "../src/storage.ts";

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
  async function seed(): Promise<{ root: string; adapter: LocalFsStorageAdapter; oldTemp: string; oldTemp2: string; freshTemp: string; recentTemp: string; finalFile: string; lookalike: string; anchoredLookalikes: string[]; linkTemp: string; dirTemp: string; outside: string }> {
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
    // Review delta2 B LOW-E4 (mutant F22: mønsteret uten sluttanker `$` slettet disse): navn som STARTER som en temp-fil men ikke ER en - en endelse etter uuid-en (`.bak`, `-1`), ett tegn for mye (`x`), 13 hex-tegn i siste
    // gruppe (`a`) og store hex-tegn (kun små bokstaver er et uuid-navn). Alle er gamle; ingen skal slettes.
    const anchoredLookalikes = [
      await make(`${tmpName("snap-5")}.bak`, 100),
      await make(`${tmpName("snap-6")}-1`, 100),
      await make(`${tmpName("snap-7")}x`, 100),
      await make(`${tmpName("snap-8")}a`, 100),
      await make(`snap-9.tmp-${randomUUID().toUpperCase()}`, 100)
    ];
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
    return { root, adapter, oldTemp, oldTemp2, freshTemp, recentTemp, finalFile, lookalike, anchoredLookalikes, linkTemp, dirTemp, outside };
  }
  const exists = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null;

  it("fjerner KUN vanlige filer som heter `<nøkkel>.tmp-<uuid>` og er eldre enn grensen; en fersk temp (kan være en skriving som pågår), et ekte objekt, et navn som bare ligner, en symlenke og en katalog står", async () => {
    const s = await seed();
    const result = await s.adapter.purgeStaleTemp(6 * HOURS);
    expect(result).toEqual({ removed: 2, failed: 0 });
    expect(await exists(s.oldTemp)).toBe(false);
    expect(await exists(s.oldTemp2)).toBe(false);
    for (const kept of [s.freshTemp, s.recentTemp, s.finalFile, s.lookalike, ...s.anchoredLookalikes, s.linkTemp, s.dirTemp, s.outside]) expect(await exists(kept), kept).toBe(true);
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

describe("purgeStaleTemp: KUN den forventede strukturen, og en avkortet gang er synlig (review delta2 B LOW-E3)", () => {
  // chmod 000 stenger ikke ute root: som root kan en uleselig mappe ikke lages, så testene som trenger den hoppes over (synlig som «skipped»).
  const canDenyRead = process.platform !== "win32" && typeof process.getuid === "function" && process.getuid() !== 0;
  const present = async (path: string): Promise<boolean> => (await lstat(path).catch(() => null)) !== null;

  /** Lagringsrot med ÉN gammel temp-fil i `snapshots/aa` og en fremmed mappe `lost+found` (uleselig) ved siden av `snapshots`. */
  async function rootWithForeignDir(): Promise<{ root: string; stale: string; foreign: string }> {
    const root = await freshRoot();
    const dir = join(root, "snapshots", "aa");
    await mkdir(dir, { recursive: true });
    const stale = join(dir, tmpName("old"));
    await writeFile(stale, BYTES);
    await age(stale, 48);
    const foreign = join(root, "lost+found");
    await mkdir(foreign);
    await writeFile(join(foreign, "fremmed-fil"), BYTES);
    await chmod(foreign, 0o000);
    return { root, stale, foreign };
  }

  it("en uleselig FREMMED mappe i roten (lost+found, chmod 000): hele roten gir failed 1 (derfor prefikset), men sveipet av `snapshots/` gir failed 0 - og den fremmede mappen røres aldri", async (ctx) => {
    if (!canDenyRead) return ctx.skip();
    const whole = await rootWithForeignDir();
    const scoped = await rootWithForeignDir();
    try {
      await expect(new LocalFsStorageAdapter(whole.root).purgeStaleTemp(6 * HOURS)).resolves.toEqual({ removed: 1, failed: 1 }); // uten prefiks: den gamle oppførselen (permanent falsk alarm)
      await expect(new LocalFsStorageAdapter(scoped.root).purgeStaleTemp(6 * HOURS, { prefix: "snapshots" })).resolves.toStrictEqual({ removed: 1, failed: 0 });
      expect(await present(scoped.stale)).toBe(false); // temp-filen i vårt navnerom ryddes som før
      expect(await present(scoped.foreign)).toBe(true);
      expect((await stat(scoped.foreign)).mode & 0o777).toBe(0o000); // urørt
    } finally {
      await chmod(whole.foreign, 0o700);
      await chmod(scoped.foreign, 0o700);
    }
  });

  it("en uleselig mappe INNE i `snapshots/` (vårt eget navnerom) er fortsatt en feil (failed 1, ikke skjult), og resten ryddes likevel", async (ctx) => {
    if (!canDenyRead) return ctx.skip();
    const { root, stale, foreign } = await rootWithForeignDir();
    const ours = join(root, "snapshots", "bb");
    await mkdir(ours);
    await chmod(ours, 0o000);
    try {
      await expect(new LocalFsStorageAdapter(root).purgeStaleTemp(6 * HOURS, { prefix: "snapshots" })).resolves.toStrictEqual({ removed: 1, failed: 1 });
      expect(await present(stale)).toBe(false);
    } finally {
      await chmod(ours, 0o700);
      await chmod(foreign, 0o700);
    }
  });

  it("prefikset: en undermappe som ikke finnes gir {0, 0}; en symlenke som prefiks følges ALDRI (målets gamle temp-filer står); et ugyldig prefiks (.., absolutt, tomt, doble skråstreker) avvises", async () => {
    const root = await freshRoot();
    const adapter = new LocalFsStorageAdapter(root);
    await expect(adapter.purgeStaleTemp(6 * HOURS, { prefix: "snapshots" })).resolves.toStrictEqual({ removed: 0, failed: 0 });
    const target = await freshRoot();
    const elsewhere = join(target, tmpName("elsewhere"));
    await writeFile(elsewhere, BYTES);
    await age(elsewhere, 48);
    await symlink(target, join(root, "snapshots"));
    await expect(adapter.purgeStaleTemp(6 * HOURS, { prefix: "snapshots" })).resolves.toStrictEqual({ removed: 0, failed: 0 });
    expect(await present(elsewhere)).toBe(true);
    for (const bad of ["..", "../x", "/etc", "", "a//b", "a/"]) await expect(adapter.purgeStaleTemp(6 * HOURS, { prefix: bad }), JSON.stringify(bad)).rejects.toBeInstanceOf(StorageKeyError);
  });

  it("AVKORTING er synlig: nås maxEntries avbrytes sveipet og `truncated: true` meldes; NØYAKTIG på grensen er ikke avkortet; neste kjøring rydder resten; ugyldig grense avvises", async () => {
    const root = await freshRoot();
    const dir = join(root, "snapshots", "aa");
    await mkdir(dir, { recursive: true });
    const stale: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const path = join(dir, tmpName(`old-${i}`));
      await writeFile(path, BYTES);
      await age(path, 48);
      stale.push(path);
    }
    const left = async (): Promise<number> => (await Promise.all(stale.map(present))).filter(Boolean).length;
    const adapter = new LocalFsStorageAdapter(root);
    // Oppføringer: mappen `aa` (1) + 4 temp-filer = 5. Grense 4: avbrutt ved den femte oppføringen, tre filer rakk å bli ryddet.
    await expect(adapter.purgeStaleTemp(6 * HOURS, { prefix: "snapshots", maxEntries: 4 })).resolves.toStrictEqual({ removed: 3, failed: 0, truncated: true });
    expect(await left()).toBe(1);
    // Nå: `aa` (1) + 1 fil = 2 oppføringer. Grense 2 er nøyaktig nok: ikke avkortet (og ingen `truncated`-nøkkel i det hele tatt).
    await expect(adapter.purgeStaleTemp(6 * HOURS, { prefix: "snapshots", maxEntries: 2 })).resolves.toStrictEqual({ removed: 1, failed: 0 });
    expect(await left()).toBe(0);
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) await expect(adapter.purgeStaleTemp(6 * HOURS, { maxEntries: bad }), String(bad)).rejects.toThrow("storage_purge_limit_invalid");
    // Uten prefiks (hele roten) avkortes det på samme måte.
    await expect(adapter.purgeStaleTemp(6 * HOURS, { maxEntries: 1 })).resolves.toStrictEqual({ removed: 0, failed: 0, truncated: true });
  });

  it("en skriverest etter en mislykket put under en EKTE nøkkel (storageKeyFor) ligger under prefikset og ryddes av det prefiks-avgrensede sveipet - nøkkelbyggeren og sveipet er enige", async () => {
    const root = await freshRoot();
    // Simulert krasj: skrivingen lyktes, men både rename og oppryddingen feilet - temp-filen blir stående.
    const crashing = new LocalFsStorageAdapter(root, { rename: async () => { throw fsError("EIO"); }, unlink: async () => { throw fsError("EIO"); } });
    const key = VisionSnapshotService.storageKeyFor("tenant-a", randomUUID());
    expect(key.startsWith(`${SNAPSHOT_KEY_PREFIX}/`)).toBe(true);
    await expect(crashing.put(key, BYTES)).rejects.toMatchObject({ code: "EIO" });
    const leftovers = await filesUnder(root);
    expect(leftovers).toHaveLength(1);
    expect(leftovers[0]).toMatch(/\.tmp-[0-9a-f-]{36}$/);
    await age(leftovers[0] as string, 48);
    const service = new VisionSnapshotService(null as never, new LocalFsStorageAdapter(root), null as never);
    await expect(service.purgeStaleTempFiles(6 * HOURS)).resolves.toStrictEqual({ removed: 1, failed: 0 });
    expect(await filesUnder(root)).toEqual([]);
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

  it("review delta2 B LOW-E3: tjenesten ber adapteren om KUN `snapshots/` (prefikset nøkkelbyggeren bruker), og gir en avkortet gang (`truncated: true`) videre uendret", async () => {
    let seen: { age: number; options: PurgeStaleTempOptions | undefined } | undefined;
    const storage: StorageAdapter = {
      backend: "other", put: async () => undefined, get: async () => null, delete: async () => ({ existed: false }), exists: async () => false,
      purgeStaleTemp: async (olderThanMs, options) => {
        seen = { age: olderThanMs, options };
        return { removed: 1, failed: 0, truncated: true };
      }
    };
    await expect(service(storage).purgeStaleTempFiles(6 * HOURS)).resolves.toStrictEqual({ removed: 1, failed: 0, truncated: true });
    expect(seen).toStrictEqual({ age: 6 * HOURS, options: { prefix: "snapshots" } });
    expect(SNAPSHOT_KEY_PREFIX).toBe("snapshots");
  });
});
