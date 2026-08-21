import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  GIT_ASKPASS_TOKEN_ENV, GIT_CREDENTIAL_ISOLATION_ARGS, buildAskpassEnvValue,
  createGitAuthHandle, generateAskpassScriptContent, generateAskpassWindowsWrapper
} from "../src/git-auth.ts";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B: ren,
 * infrastrukturfri testing av det ephemere GIT_ASKPASS-mekanismen. INGEN
 * ekte git/nettverk/GitHub her - kun skript-innhold, filsystem-ephemeritet,
 * og selve skriptets kjøretidsoppførsel (kjørt direkte, uten git involvert).
 *
 * D-103 HOST-FIX (2026-08-21): `handle.env["GIT_ASKPASS"]` er nå PLATTFORM-
 * BETINGET (se `buildAskpassEnvValue()`) - på POSIX (denne test-kjørings-
 * plattformen) er verdien en BAR, UANFØRSELSTEGNET sti direkte til
 * `askpass.cjs` (INGEN mer `"<node>" "<skript>"`-anførselstegn-splitting
 * nødvendig for å hente ut stien - det VAR nettopp den formen som viste seg
 * å være en latent ENOENT-bug på POSIX, se doc-kommentaren i git-auth.ts).
 */
describe("D-103: git-auth.ts - ephemer GIT_ASKPASS-mekanisme", () => {
  it("A: generateAskpassScriptContent() refererer GIT_ASKPASS_TOKEN_ENV, ALDRI et hardkodet token", () => {
    const content = generateAskpassScriptContent();
    expect(content).toContain(GIT_ASKPASS_TOKEN_ENV);
    expect(content).not.toMatch(/sk-ant-|ghp_|gho_/);
  });

  it("B: createGitAuthHandle() sitt GIT_ASKPASS er (på POSIX) en BAR sti til askpass.cjs - ALDRI anførselstegnet, ALDRI en node-binær-prefiks", async () => {
    const handle = await createGitAuthHandle("test-token-b");
    try {
      const value = handle.env["GIT_ASKPASS"] as string;
      expect(value).not.toMatch(/^"/); // ALDRI anførselstegnet på POSIX (denne testplattformen)
      expect(value).not.toContain(process.execPath); // INGEN node-binær-prefiks i selve verdien
      expect(value.endsWith("askpass.cjs")).toBe(true);
      await expect(stat(value)).resolves.toBeDefined(); // filen finnes faktisk på den oppgitte stien
    } finally {
      await handle.cleanup();
    }
  });

  it("C: GIT_TERMINAL_PROMPT=0 satt - tvinger askpass fremfor interaktiv/ambient fallback", async () => {
    const handle = await createGitAuthHandle("test-token-c");
    try {
      expect(handle.env["GIT_TERMINAL_PROMPT"]).toBe("0");
    } finally {
      await handle.cleanup();
    }
  });

  it("D: token-verdien finnes KUN i env[GIT_ASKPASS_TOKEN_ENV] - ingen andre env-nøkler bærer den", async () => {
    const token = "test-token-d-unique-value";
    const handle = await createGitAuthHandle(token);
    try {
      expect(handle.env[GIT_ASKPASS_TOKEN_ENV]).toBe(token);
      const otherKeys = Object.keys(handle.env).filter((k) => k !== GIT_ASKPASS_TOKEN_ENV);
      for (const key of otherKeys) {
        expect(handle.env[key as keyof typeof handle.env]).not.toContain(token);
      }
    } finally {
      await handle.cleanup();
    }
  });

  it("E: selve askpass-skriptfilen på disk inneholder ALDRI token-verdien - kun logikk", async () => {
    const token = "test-token-e-never-on-disk";
    const handle = await createGitAuthHandle(token);
    try {
      const scriptPath = handle.env["GIT_ASKPASS"] as string;
      const fileContent = await readFile(scriptPath, "utf8");
      expect(fileContent).not.toContain(token);
    } finally {
      await handle.cleanup();
    }
  });

  it("F: cleanup() fjerner den ephemere temp-katalogen fullstendig", async () => {
    const handle = await createGitAuthHandle("test-token-f");
    const scriptPath = handle.env["GIT_ASKPASS"] as string;
    await handle.cleanup();
    await expect(stat(scriptPath)).rejects.toThrow();
  });

  it("G: to separate createGitAuthHandle()-kall gir to distinkte, isolerte temp-kataloger", async () => {
    const a = await createGitAuthHandle("token-a");
    const b = await createGitAuthHandle("token-b");
    try {
      expect(a.env["GIT_ASKPASS"]).not.toBe(b.env["GIT_ASKPASS"]);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  // H/I/J bruker det EKTE genererte skriptet fra createGitAuthHandle() (via GIT_ASKPASS-
  // stien), kjørt EKSAKT slik git selv ville kalt det på POSIX - `node <skriptfil> "<prompt>"`
  // (argv[2] = prompt) - ALDRI `node -e` (som ville gitt en annen argv-indeksering).
  it("H: skriptet kjørt med et username-prompt returnerer den faste identiteten 'x-access-token', ALDRI tomt/undefined", async () => {
    const handle = await createGitAuthHandle("unused-token-h");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"] as string;
      const result = spawnSync(process.execPath, [scriptPath, "Username for 'https://github.com': "], { encoding: "utf8" });
      expect(result.stdout).toBe("x-access-token");
    } finally {
      await handle.cleanup();
    }
  });

  it("I: skriptet kjørt med et password-prompt OG env satt returnerer nøyaktig token-verdien", async () => {
    const handle = await createGitAuthHandle("unused-token-i");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"] as string;
      const result = spawnSync(process.execPath, [scriptPath, "Password for 'https://x-access-token@github.com': "], {
        encoding: "utf8",
        env: { ...process.env, [GIT_ASKPASS_TOKEN_ENV]: "expected-token-i" }
      });
      expect(result.stdout).toBe("expected-token-i");
    } finally {
      await handle.cleanup();
    }
  });

  it("J: skriptet kjørt med et password-prompt UTEN env satt returnerer tom streng - kaster ALDRI, skriver ALDRI 'undefined'", async () => {
    const handle = await createGitAuthHandle("unused-token-j");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"] as string;
      const env = { ...process.env };
      delete env[GIT_ASKPASS_TOKEN_ENV];
      const result = spawnSync(process.execPath, [scriptPath, "Password for 'https://github.com': "], { encoding: "utf8", env });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stdout).not.toContain("undefined");
    } finally {
      await handle.cleanup();
    }
  });

  it("K: askpass.cjs er faktisk kjørbar (chmod 0o700) på POSIX - direkte shebang-invokering, ALDRI en node-wrapper nødvendig", async () => {
    const handle = await createGitAuthHandle("unused-token-k");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"] as string;
      // Kjører skriptet DIREKTE (ingen `process.execPath`-prefiks) - dette er
      // EKSAKT det git selv gjør på POSIX (execvp() av GIT_ASKPASS-stien).
      const result = spawnSync(scriptPath, ["Username for 'https://github.com': "], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("x-access-token");
    } finally {
      await handle.cleanup();
    }
  });

  it("L: buildAskpassEnvValue() returnerer BAR sti (ingen anførselstegn) for alle POSIX-plattformer (linux/darwin)", () => {
    expect(buildAskpassEnvValue("linux", "/tmp/x/askpass.cjs")).toBe("/tmp/x/askpass.cjs");
    expect(buildAskpassEnvValue("darwin", "/tmp/x/askpass.cjs")).toBe("/tmp/x/askpass.cjs");
  });

  it("M: buildAskpassEnvValue() anførselstegner stien for win32 (Windows-kommandolinje-konvensjon, støtter stier med mellomrom)", () => {
    expect(buildAskpassEnvValue("win32", "C:\\Users\\Tobias H\\Temp\\x\\askpass.cmd"))
      .toBe('"C:\\Users\\Tobias H\\Temp\\x\\askpass.cmd"');
  });

  it("N: generateAskpassWindowsWrapper() genererer en gyldig .cmd-batch-linje som kaller node med skriptet og videresender ALLE argumenter (%*)", () => {
    const content = generateAskpassWindowsWrapper("C:\\Program Files\\nodejs\\node.exe", "C:\\temp\\x\\askpass.cjs");
    expect(content).toBe('@"C:\\Program Files\\nodejs\\node.exe" "C:\\temp\\x\\askpass.cjs" %*\r\n');
    expect(content).not.toMatch(/sk-ant-|ghp_|gho_/); // ingen hemmelighet i wrapperen
  });

  it("O: createGitAuthHandle()s env inneholder ALDRI en .cmd-artefakt på POSIX (kun genereres på win32)", async () => {
    const handle = await createGitAuthHandle("unused-token-o");
    try {
      expect(handle.env["GIT_ASKPASS"]).not.toMatch(/\.cmd$/);
    } finally {
      await handle.cleanup();
    }
  });

  it("P: GIT_CREDENTIAL_ISOLATION_ARGS er eksakt ['-c', 'credential.helper='] - git sin egen dokumenterte nullstill-helper-kjede-mekanisme, ingen hemmelighet", () => {
    expect(GIT_CREDENTIAL_ISOLATION_ARGS).toEqual(["-c", "credential.helper="]);
  });
});
