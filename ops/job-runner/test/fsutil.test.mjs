import { spawnSync } from "node:child_process";
import { chmod, link as fs_link, lstat, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../lib/errors.mjs";
import { assertPrivateDir, ensurePrivateDir, forceRemoveTree, isPathInside, readSecretFile } from "../lib/fsutil.mjs";

const tmp = () => mkdtemp(join(tmpdir(), "jr-fs-"));
const err = async (promise) => {
  try { await promise; } catch (e) { return e instanceof ConfigError ? e.code : `other:${e instanceof Error ? e.message : e}`; }
  return "no_error";
};

describe("A: readSecretFile - en hemmelighet andre kan lese er ingen hemmelighet", () => {
  const make = async (mode, content = "tok-0123456789abcdef0123456789abcdef\n") => {
    const dir = await tmp();
    const file = join(dir, "secret");
    await writeFile(file, content);
    await chmod(file, mode);
    return { dir, file };
  };

  it("leser fil med modus 0600/0640/0400/0440 og fjerner avsluttende whitespace", async () => {
    for (const mode of [0o600, 0o640, 0o400, 0o440]) {
      const { file } = await make(mode);
      expect(await readSecretFile(file)).toBe("tok-0123456789abcdef0123456789abcdef");
    }
  });

  it("nekter lesbar for andre, skrivbar for gruppe, kjørbar", async () => {
    for (const mode of [0o644, 0o604, 0o601, 0o660, 0o620, 0o610, 0o700, 0o666, 0o777]) {
      const { file } = await make(mode);
      expect(await err(readSecretFile(file)), mode.toString(8)).toBe("secret_file_permissions_too_open");
    }
  });

  it("forbiddenModeBits 0o177 (git-PAT): kun eier kan lese - 0600/0400 godtas, ALL gruppe-/andre-tilgang nektes (også gruppe-lesing som bearer-tokenet har)", async () => {
    for (const mode of [0o600, 0o400]) expect(await readSecretFile((await make(mode)).file, { forbiddenModeBits: 0o177 }), mode.toString(8)).toContain("tok-");
    for (const mode of [0o640, 0o440, 0o604, 0o644, 0o660, 0o700, 0o500, 0o777]) {
      expect(await err(readSecretFile((await make(mode)).file, { forbiddenModeBits: 0o177 })), mode.toString(8)).toBe("secret_file_permissions_too_open");
    }
    // uten parameteren er standarden uendret (bearer-tokenet deles med worker via gruppen)
    expect(await readSecretFile((await make(0o640)).file)).toContain("tok-");
  });

  it("nekter symlenke (O_NOFOLLOW), katalog, for stor fil, manglende fil og relativ sti", async () => {
    const real = await make(0o600);
    const link = join(real.dir, "link");
    await symlink(real.file, link);
    expect(await err(readSecretFile(link))).toBe("secret_file_is_symlink");
    expect(await err(readSecretFile(real.dir))).toMatch(/secret_file_(not_a_regular_file|unreadable)/);
    expect(await err(readSecretFile((await make(0o600, "x".repeat(17_000))).file))).toBe("secret_file_too_large");
    expect(await err(readSecretFile((await make(0o600, "x".repeat(16_385))).file))).toBe("secret_file_too_large");
    expect(await err(readSecretFile(join(real.dir, "nope")))).toBe("secret_file_unreadable");
    expect(await err(readSecretFile("relative"))).toBe("secret_file_path_not_absolute");
  });

  it("godtar et langt token (opp mot filtaket 16 KiB), for eksempel en installasjonstoken-lignende verdi på 8192 tegn + linjeskift", async () => {
    const { file } = await make(0o600, `${"a".repeat(8192)}\n`);
    expect(await readSecretFile(file)).toBe("a".repeat(8192));
    const big = await make(0o600, "b".repeat(16_384));
    expect(await readSecretFile(big.file)).toHaveLength(16_384);
  });

  it("nekter feil eier (tjenestebruker/root er de eneste tillatte), med mindre eier-sjekken eksplisitt hoppes over (KUN tester)", async () => {
    const { file } = await make(0o600);
    expect(await err(readSecretFile(file, { allowedOwnerUids: [] }))).toBe("secret_file_wrong_owner");
    expect(await readSecretFile(file, { allowedOwnerUids: [], skipOwnerCheck: true })).toContain("tok-");
  });

  it("feilmeldingen inneholder aldri filinnholdet", async () => {
    const { file } = await make(0o644, "SUPER-HEMMELIG-VERDI-1234567890");
    try { await readSecretFile(file); } catch (e) { expect(String(e.message)).not.toContain("SUPER-HEMMELIG"); }
  });
});

describe("B: private kataloger", () => {
  it("ensurePrivateDir oppretter 0700 og strammer inn for åpen katalog", async () => {
    const base = await tmp();
    const dir = join(base, "a", "b");
    await ensurePrivateDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    await chmod(dir, 0o755);
    await assertPrivateDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  it("nekter symlenke i stedet for katalog, og relativ sti", async () => {
    const base = await tmp();
    const real = join(base, "real");
    await mkdir(real, { mode: 0o700 });
    const link = join(base, "link");
    await symlink(real, link);
    expect(await err(assertPrivateDir(link))).toBe("dir_not_a_plain_directory");
    expect(await err(ensurePrivateDir("relative/dir"))).toBe("dir_not_absolute");
  });
});

describe("C: forceRemoveTree - rydder agent-skrevet innhold uten å følge symlenker", () => {
  it("fjerner katalog med modus 000, skrivebeskyttede filer og dype tre", async () => {
    const root = await tmp();
    const dir = join(root, "job");
    await mkdir(join(dir, "a", "b", "c"), { recursive: true });
    await writeFile(join(dir, "a", "b", "c", "f.txt"), "x");
    await writeFile(join(dir, "a", "ro.txt"), "x");
    await chmod(join(dir, "a", "ro.txt"), 0o400);
    await chmod(join(dir, "a", "b", "c"), 0o000); // agenten har fjernet all tilgang
    await chmod(join(dir, "a", "b"), 0o500);      // og skrivetilgang
    await forceRemoveTree(dir);
    await expect(lstat(dir)).rejects.toThrow();
  });

  it("følger ALDRI en symlenke ut av treet: målet utenfor overlever (fil og katalog)", async () => {
    const root = await tmp();
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "sentinel.txt"), "skal-overleve");
    const outsideFile = join(root, "sentinel-file.txt");
    await writeFile(outsideFile, "skal-overleve");
    const dir = join(root, "job");
    await mkdir(dir);
    await symlink(outsideDir, join(dir, "dirlink"));
    await symlink(outsideFile, join(dir, "filelink"));
    await symlink("/etc", join(dir, "etclink"));
    await symlink(dir, join(dir, "selfloop")); // løkke
    await forceRemoveTree(dir);
    await expect(lstat(dir)).rejects.toThrow();
    expect(await readFile(join(outsideDir, "sentinel.txt"), "utf8")).toBe("skal-overleve");
    expect(await readFile(outsideFile, "utf8")).toBe("skal-overleve");
    expect((await lstat("/etc")).isDirectory()).toBe(true);
  });

  /**
   * Bygger et adversarielt tre i en BARNEPROSESS (chdir/Buffer-stier endrer ikke testprosessen). `script` kjøres med `ROOT` (Buffer) og `fs` i scope.
   * @param {string} root @param {string} script
   */
  const build = (root, script) => {
    const r = spawnSync(process.execPath, ["-e", `const fs = require("fs"); const ROOT = ${JSON.stringify(root)}; process.chdir(ROOT); ${script}`], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`kunne ikke bygge treet: ${r.stderr.slice(0, 300)}`);
  };
  /** N nivåer med navn av `name`, en blad-fil nederst og (valgfritt) en symlenke ut av treet; nederste katalog gjøres skrivebeskyttet. */
  const deepScript = (dirName, levels, name, linkTarget = "") =>
    `fs.mkdirSync(${JSON.stringify(dirName)}); process.chdir(${JSON.stringify(dirName)}); const n = ${name}; ` +
    `for (let i = 0; i < ${levels}; i += 1) { fs.mkdirSync(n); process.chdir(n); } fs.writeFileSync("leaf.txt", "x"); ` +
    `${linkTarget ? `fs.symlinkSync(${JSON.stringify(linkTarget)}, "outlink");` : ""} fs.chmodSync(".", 0o500); process.chdir(ROOT);`;

  it("DYPT tre (lengre enn PATH_MAX, 30 x 200 tegn) fjernes helt", async () => {
    const base = await tmp();
    const job = join(base, "job");
    await mkdir(job);
    build(job, deepScript("deep", 30, '"d".repeat(200)'));
    await expect(lstat(join(job, "deep"))).resolves.toBeTruthy();
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
  }, 60_000);

  it("DYPT tre med FLERBYTE-tegn: 25 x 85 tegn à 3 bytes = 6375 bytes (over PATH_MAX) men bare 2125 tegn - en lengdesjekk i tegn ville latt den stå igjen", async () => {
    const base = await tmp();
    const job = join(base, "job");
    await mkdir(job);
    build(job, deepScript("deep", 25, '"日".repeat(85)'));
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
  }, 60_000);

  it("filnavn som IKKE er gyldig UTF-8 (fil, katalog med innhold, navn med linjeskift og ledende bindestrek): alt fjernes - en JavaScript-streng kan ikke adressere dem", async () => {
    const base = await tmp();
    const job = join(base, "job");
    await mkdir(job);
    build(job, `
      const at = (...parts) => Buffer.concat([Buffer.from(ROOT + "/"), ...parts]);
      fs.writeFileSync(at(Buffer.from([0xff, 0xfe, 0x41])), "x");
      fs.mkdirSync(at(Buffer.from([0xc3, 0x28])));
      fs.writeFileSync(at(Buffer.from([0xc3, 0x28]), Buffer.from("/"), Buffer.from([0x80, 0x81])), "y");
      fs.writeFileSync(at(Buffer.from("-rf\\n--no-preserve-root")), "z");
      fs.writeFileSync(at(Buffer.from("med linjeskift\\nog tab\\t")), "w");
      fs.mkdirSync(at(Buffer.from([0xed, 0xa0, 0x80])));`); // en enslig surrogat kodet som UTF-8 (ugyldig)
    expect((await readdir(job)).length).toBe(5);
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
  });

  it("blanding: dype grener (symlenker ut av treet), 000-kataloger, ugyldige navn og en vanlig fil - ingen symlenke følges, målene utenfor overlever", async () => {
    const base = await tmp();
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "sentinel.txt"), "skal-overleve");
    const job = join(base, "job");
    await mkdir(job);
    await writeFile(join(job, "vanlig.txt"), "x");
    build(job, deepScript("a", 25, '"e".repeat(220)', outside));
    build(job, deepScript("b", 40, '"å".repeat(120)', "/etc"));
    build(job, `fs.writeFileSync(Buffer.concat([Buffer.from(ROOT + "/"), Buffer.from([0xff])]), "x"); fs.mkdirSync("z"); fs.writeFileSync("z/f", "x"); fs.chmodSync("z", 0);`);
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("skal-overleve");
    expect((await lstat("/etc")).isDirectory()).toBe(true);
  }, 60_000);

  it("en flat katalog med mange oppføringer (30 000 filer) fjernes uten å lese alt inn i minnet i runneren (rm kjører i egen prosess)", async () => {
    const base = await tmp();
    const job = join(base, "job");
    await mkdir(job);
    build(job, `fs.mkdirSync("flat"); for (let i = 0; i < 30000; i += 1) fs.writeFileSync("flat/f" + i, "");`);
    const before = process.memoryUsage().rss;
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
    expect(process.memoryUsage().rss - before).toBeLessThan(150 * 1024 * 1024);
  }, 60_000);

  it("special-filer og harde lenker: fifo, socket og hardlenke i treet fjernes; en hardlenke utenfor treet påvirkes bare ved at lenken forsvinner", async () => {
    const base = await tmp();
    const outside = join(base, "outside.txt");
    await writeFile(outside, "skal-overleve");
    const job = join(base, "job");
    await mkdir(job);
    build(job, `
      require("child_process").execFileSync("mkfifo", ["pipe"]);
      require("net").createServer().listen("sock.sock");
      setTimeout(() => process.exit(0), 50);`);
    await fs_link(outside, join(job, "hardlink"));
    await forceRemoveTree(job);
    await expect(lstat(job)).rejects.toThrow();
    expect(await readFile(outside, "utf8")).toBe("skal-overleve");
  });

  it("en FIL eller SYMLENKE som rot fjernes (selve lenken, aldri målet)", async () => {
    const base = await tmp();
    const target = join(base, "target");
    await mkdir(target);
    await writeFile(join(target, "keep.txt"), "x");
    const link = join(base, "root-link");
    await symlink(target, link);
    await forceRemoveTree(link);
    await expect(lstat(link)).rejects.toThrow();
    expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("x");
    const file = join(base, "root-file");
    await writeFile(file, "x");
    await forceRemoveTree(file);
    await expect(lstat(file)).rejects.toThrow();
  });

  it("nekter roten og toppnivåkataloger (en feil hos kalleren kan ikke tømme / eller /var), og stier med .. normaliseres FØR sjekken", async () => {
    for (const path of ["/", "/tmp", "/var", "/etc/", "/tmp/..", "/tmp/x/../.."]) {
      await expect(forceRemoveTree(path), path).rejects.toThrow("force_remove_refuses_shallow_path");
    }
    expect((await lstat("/etc")).isDirectory()).toBe(true);
  });

  it.skipIf(process.getuid?.() === 0)("kan ikke fjerne (foreldrekatalogen er skrivebeskyttet): feiler lukket med en kode uten filnavn, og treet blir stående", async () => {
    const base = await tmp();
    const parent = join(base, "parent");
    const job = join(parent, "job");
    await mkdir(job, { recursive: true });
    await writeFile(join(job, "a-hemmelig-fil.txt"), "x");
    await chmod(parent, 0o500);
    try {
      const error = await forceRemoveTree(job).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toMatch(/^force_remove_incomplete:(rm_failed|still_exists)$/);
      expect(error.message).not.toContain("a-hemmelig-fil");
      expect((await lstat(job)).isDirectory()).toBe(true);
    } finally {
      await chmod(parent, 0o700);
    }
    await forceRemoveTree(job); // gjenopptakelse etter at årsaken er borte
    await expect(lstat(job)).rejects.toThrow();
  });

  it("tidsavbrudd, verktøy som ikke kan startes og feilstatus gir egne stabile koder (injisert prosesskjører)", async () => {
    const base = await tmp();
    const job = join(base, "job");
    await mkdir(job);
    const ok = { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false };
    const calls = [];
    const runWith = (rm) => async (bin, args, options) => { calls.push({ bin, args, env: options.env, timeoutMs: options.timeoutMs }); return bin.endsWith("rm") ? { ...ok, ...rm } : ok; };
    await expect(forceRemoveTree(job, { run: runWith({ timedOut: true, status: null }), timeoutMs: 1234 })).rejects.toThrow("force_remove_incomplete:rm_timeout");
    await expect(forceRemoveTree(job, { run: runWith({ spawnError: "ENOENT", status: null }) })).rejects.toThrow("force_remove_incomplete:rm_not_runnable");
    await expect(forceRemoveTree(job, { run: runWith({ status: 1 }) })).rejects.toThrow("force_remove_incomplete:rm_failed");
    // rm melder suksess, men treet er der fortsatt: aldri en stille «ferdig»
    await expect(forceRemoveTree(job, { run: runWith({ status: 0 }) })).rejects.toThrow("force_remove_incomplete:still_exists");
    // kommandolinjene: absolutte verktøy, `--` før stien, ingen shell, fast miljø, tidsgrensen videreføres
    const rmCall = calls.find((c) => c.bin === "/bin/rm");
    expect(rmCall.args).toEqual(["-rf", "--one-file-system", "--", job]);
    expect(calls[0]).toMatchObject({ bin: "/bin/chmod", args: ["-R", "u+rwx", "--", job], timeoutMs: 1234 });
    expect(Object.keys(rmCall.env).sort()).toEqual(["LANG", "LC_ALL", "PATH"]);
  });

  it("er idempotent for manglende sti og nekter relativ sti", async () => {
    const root = await tmp();
    await forceRemoveTree(join(root, "finnes-ikke"));
    await expect(forceRemoveTree("relativ/sti")).rejects.toThrow("force_remove_requires_absolute_path");
  });
});

describe("D: isPathInside", () => {
  it("strengt innenfor; ikke seg selv, ikke søsken med felles prefiks, ikke ..-flukt", () => {
    expect(isPathInside("/a/b", "/a/b/c")).toBe(true);
    expect(isPathInside("/a/b", "/a/b")).toBe(false);
    expect(isPathInside("/a/b", "/a/bc")).toBe(false);
    expect(isPathInside("/a/b", "/a/b/../c")).toBe(false);
    expect(isPathInside("/a/b", "/etc/passwd")).toBe(false);
  });
});
