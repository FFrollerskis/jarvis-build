import { chmod, lstat, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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
