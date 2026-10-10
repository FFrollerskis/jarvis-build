import { lutimesSync, mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeSet, tempDir } from "./helpers.mjs";

/**
 * WP-C2 review runde 2 (M3). `findOrphanSets` avgjorde «mangler manifest» med `existsSync`, som gir `false` ved ENHVER feil - også EACCES/EIO/ESTALE på en ustø NFS-/USB-montering. Et GODT sett
 * kunne dermed `rm -rf`-es av en forbigående feil. Her injiseres filsystemfeil med kjent feilkode i `lstat`/`readdir` (ekte feil av denne typen kan ikke lages i et testmiljø): bare ENOENT beviser
 * at noe mangler; alt annet betyr «vet ikke», og katalogen røres ikke.
 */
const inject = vi.hoisted(() => ({ lstat: new Map(), readdir: new Map() }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal();
  const maybeFail = (table, path) => {
    const code = table.get(String(path));
    if (code !== undefined) throw Object.assign(new Error(`${code}: injisert`), { code });
  };
  return {
    ...actual,
    lstatSync: (path, ...rest) => { maybeFail(inject.lstat, path); return actual.lstatSync(path, ...rest); },
    readdirSync: (path, ...rest) => { maybeFail(inject.readdir, path); return actual.readdirSync(path, ...rest); }
  };
});
const { findOrphanSets, scanManifestlessSets } = await import("../lib/schedule.mjs");

afterAll(cleanupTempDirs);
afterEach(() => {
  inject.lstat.clear();
  inject.readdir.clear();
});
const NOW = new Date("2026-10-09T02:00:00.000Z").getTime();
const H = 3_600_000;

function oldEmptyOrphan(out, name = "jarvis-backup-20260101T000000Z", ageH = 30) {
  const dir = join(out, name);
  mkdirSync(dir);
  const t = new Date(NOW - ageH * H);
  utimesSync(dir, t, t);
  return dir;
}

describe("WP-C2 review runde 2 M3: foreldreløs-skanningen skiller ENOENT fra «vet ikke»", () => {
  it("kontroll: en gammel, TOM katalog uten manifest er ryddbar (ENOENT = bevist fravær); manifest, ung alder, symlenke og beskyttet navn gjør den det ikke", () => {
    const out = tempDir("wpc2-orph-");
    const dir = oldEmptyOrphan(out);
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [dir], withData: [], unverified: [] });
    expect(scanManifestlessSets(out, NOW, { protect: ["jarvis-backup-20260101T000000Z"] }).removable).toEqual([]);
    expect(findOrphanSets(out, NOW, 31 * H)).toEqual([]); // yngre enn terskelen
    expect(scanManifestlessSets(join(out, "finnes-ikke"), NOW)).toEqual({ removable: [], withData: [], unverified: [] }); // ENOENT på selve mappen er ikke en feil
  });

  it("en symlenke (eller fil) med settnavn røres aldri, selv om den peker på en tom, gammel katalog", () => {
    const out = tempDir("wpc2-orph-");
    const target = join(tempDir("wpc2-orph-target-"), "tom");
    mkdirSync(target);
    const t = new Date(NOW - 30 * H);
    utimesSync(target, t, t);
    const link = join(out, "jarvis-backup-20260101T000000Z");
    symlinkSync(target, link);
    lutimesSync(link, t, t); // symlenkens EGEN alder er også høy: kun type-sjekken (ikke alderen) kan stoppe den
    const file = join(out, "jarvis-backup-20260102T000000Z");
    writeFileSync(file, "en fil");
    utimesSync(file, t, t);
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [], unverified: [] });
  });

  for (const code of ["EACCES", "EIO", "ESTALE", "ETIMEDOUT", "ELOOP", "ENOTDIR", "EPERM"]) {
    it(`${code} på manifestsjekken: katalogen røres IKKE (uverifiserbar), selv når den er tom og gammel - tidligere ble den slettet`, () => {
      const out = tempDir("wpc2-orph-");
      const dir = oldEmptyOrphan(out);
      inject.lstat.set(join(dir, "manifest.json"), code);
      expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [], unverified: [{ name: "jarvis-backup-20260101T000000Z", code }] });
      expect(findOrphanSets(out, NOW)).toEqual([]);
    });
  }

  it("et GODT sett (manifest + filer) hvis manifestsjekk feiler forbigående er aldri ryddbart og regnes aldri som «data uten manifest»", () => {
    const out = tempDir("wpc2-orph-");
    const set = makeSet(out, new Date(NOW - 40 * H));
    const t = new Date(NOW - 40 * H);
    utimesSync(set.dir, t, t);
    inject.lstat.set(join(set.dir, "manifest.json"), "EIO");
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [], unverified: [{ name: set.name, code: "EIO" }] });
  });

  it("feil på selve settkatalogen (lstat/readdir) og på backup-mappen er «vet ikke» - aldri «tom»", () => {
    const out = tempDir("wpc2-orph-");
    const dir = oldEmptyOrphan(out);
    inject.readdir.set(dir, "EIO");
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [], unverified: [{ name: "jarvis-backup-20260101T000000Z", code: "EIO" }] });
    inject.readdir.clear();
    inject.lstat.set(dir, "ESTALE");
    expect(scanManifestlessSets(out, NOW).unverified).toEqual([{ name: "jarvis-backup-20260101T000000Z", code: "ESTALE" }]);
    inject.lstat.clear();
    inject.readdir.set(out, "EACCES");
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [], unverified: [{ name: "(backup-mappen)", code: "EACCES" }] });
  });

  it("innhold uten manifest rapporteres som `withData` (ikke ryddbart); et .age-fragment er nok til å beskytte katalogen", () => {
    const out = tempDir("wpc2-orph-");
    const dir = oldEmptyOrphan(out);
    writeFileSync(join(dir, "jarvis.dump.age"), "halvferdig");
    const t = new Date(NOW - 30 * H);
    utimesSync(dir, t, t);
    expect(scanManifestlessSets(out, NOW)).toEqual({ removable: [], withData: [{ name: "jarvis-backup-20260101T000000Z", entries: 1 }], unverified: [] });
  });
});
