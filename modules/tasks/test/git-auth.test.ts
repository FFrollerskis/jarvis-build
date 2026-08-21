import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GIT_ASKPASS_TOKEN_ENV, createGitAuthHandle, generateAskpassScriptContent } from "../src/git-auth.ts";

/**
 * D-103 (UA-5 Production Coding Reachability Repair v1) - Blokker B: ren,
 * infrastrukturfri testing av det ephemere GIT_ASKPASS-mekanismen. INGEN
 * ekte git/nettverk/GitHub her - kun skript-innhold, filsystem-ephemeritet,
 * og selve skriptets kjøretidsoppførsel (kjørt direkte, uten git involvert).
 */
describe("D-103: git-auth.ts - ephemer GIT_ASKPASS-mekanisme", () => {
  it("A: generateAskpassScriptContent() refererer GIT_ASKPASS_TOKEN_ENV, ALDRI et hardkodet token", () => {
    const content = generateAskpassScriptContent();
    expect(content).toContain(GIT_ASKPASS_TOKEN_ENV);
    expect(content).not.toMatch(/sk-ant-|ghp_|gho_/);
  });

  it("B: createGitAuthHandle() sitt env inneholder GIT_ASKPASS pekende på quoted node+skript-sti", async () => {
    const handle = await createGitAuthHandle("test-token-b");
    try {
      expect(handle.env["GIT_ASKPASS"]).toContain(process.execPath);
      expect(handle.env["GIT_ASKPASS"]).toMatch(/^".*"\s+".*"$/);
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
      const scriptPath = handle.env["GIT_ASKPASS"]?.split('"')[3] as string;
      const fileContent = await readFile(scriptPath, "utf8");
      expect(fileContent).not.toContain(token);
    } finally {
      await handle.cleanup();
    }
  });

  it("F: cleanup() fjerner den ephemere temp-katalogen fullstendig", async () => {
    const handle = await createGitAuthHandle("test-token-f");
    const scriptPath = handle.env["GIT_ASKPASS"]?.split('"')[3] as string;
    await handle.cleanup();
    await expect(stat(scriptPath)).rejects.toThrow();
  });

  it("G: to separate createGitAuthHandle()-kall gir to distinkte, isolerte temp-kataloger", async () => {
    const a = await createGitAuthHandle("token-a");
    const b = await createGitAuthHandle("token-b");
    try {
      const pathA = a.env["GIT_ASKPASS"]?.split('"')[3];
      const pathB = b.env["GIT_ASKPASS"]?.split('"')[3];
      expect(pathA).not.toBe(pathB);
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  });

  // H/I/J bruker det EKTE genererte skriptet fra createGitAuthHandle() (via GIT_ASKPASS-
  // stien), kjørt EKSAKT slik git selv ville kalt det - `node <skriptfil> "<prompt>"`
  // (argv[2] = prompt) - ALDRI `node -e` (som ville gitt en annen argv-indeksering).
  it("H: skriptet kjørt med et username-prompt returnerer den faste identiteten 'x-access-token', ALDRI tomt/undefined", async () => {
    const handle = await createGitAuthHandle("unused-token-h");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"]?.split('"')[3] as string;
      const result = spawnSync(process.execPath, [scriptPath, "Username for 'https://github.com': "], { encoding: "utf8" });
      expect(result.stdout).toBe("x-access-token");
    } finally {
      await handle.cleanup();
    }
  });

  it("I: skriptet kjørt med et password-prompt OG env satt returnerer nøyaktig token-verdien", async () => {
    const handle = await createGitAuthHandle("unused-token-i");
    try {
      const scriptPath = handle.env["GIT_ASKPASS"]?.split('"')[3] as string;
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
      const scriptPath = handle.env["GIT_ASKPASS"]?.split('"')[3] as string;
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
});
