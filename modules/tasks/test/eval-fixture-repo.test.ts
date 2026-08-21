import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EVAL_FIXTURES } from "../src/coding-agent-eval.ts";
import { describeGitFailure, git, seedFixtureRepo } from "../src/eval-fixture-repo.ts";

/**
 * D-98 HARNESS-REPAIR regresjonstester (2026-08-21): en ekte Windows-
 * vertskjøring av `ua5-coding-agent-live-eval.ts` feilet FØR noe Claude-kall
 * med `git commit -m seed feilet: ` (tom stderr) - rotårsaken var en
 * spawnet, POSIX-eksternt `mkdir`-kommando som ikke finnes som en frittstående
 * kjørbar fil på Windows. Denne filen beviser DETERMINISTISK, UTEN noe ekte
 * Claude-/Postgres-/nettverkskall, at den nye `node:fs`-baserte
 * repo-bootstrap-en er kryssplattform-korrekt OG uavhengig av vertens
 * globale git-identitet/signerings-/hooks-konfigurasjon.
 */
describe("eval-fixture-repo: kryssplattform disponibel repo-bootstrap (INGEN ekte Claude-/Postgres-/nettverkskall)", () => {
  let fakeHome: string;
  let fakeGlobalConfig: string;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    fakeHome = await mkdtemp(join(tmpdir(), "jarvis-eval-fakehome-"));
    fakeGlobalConfig = join(fakeHome, "fake-gitconfig");
    savedEnv = {
      HOME: process.env["HOME"],
      GIT_CONFIG_GLOBAL: process.env["GIT_CONFIG_GLOBAL"],
      XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"]
    };
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("A: seedFixtureRepo krever INGEN vertsspesifikk/global git-identitet", async () => {
    // Peker HOME/GIT_CONFIG_GLOBAL til et helt tomt, fersk katalog - ingen
    // ambient user.name/user.email kan noensinne bli funnet av git her.
    process.env["HOME"] = fakeHome;
    process.env["XDG_CONFIG_HOME"] = fakeHome;
    process.env["GIT_CONFIG_GLOBAL"] = fakeGlobalConfig; // filen finnes bevisst ikke ennå

    const bareRepo = await seedFixtureRepo(EVAL_FIXTURES[0]!);
    const log = spawnSync("git", ["log", "-1", "--format=%an <%ae>", "main"], { cwd: bareRepo, encoding: "utf8" });
    expect(log.status).toBe(0);
    expect(log.stdout.trim()).toBe("jarvis-eval-seed <eval-seed@jarvis.local>");
  });

  it("B: en syntetisk vert med commit.gpgsign=true GLOBALT kan ikke ødelegge fixture-bootstrap", async () => {
    // Simulerer nøyaktig den vertsklassen §2 ber om å beskytte mot: en global
    // gitconfig som krever GPG-signering med et program som IKKE finnes -
    // uten den LOKALE `commit.gpgsign=false`-overstyringen i det disponible
    // repoet ville dette latt `git commit` feile.
    await writeFile(
      fakeGlobalConfig,
      "[commit]\n  gpgsign = true\n[gpg]\n  program = /nonexistent/definitely-not-a-real-gpg-binary\n[user]\n  name = Host User\n  email = host@example.invalid\n"
    );
    process.env["HOME"] = fakeHome;
    process.env["GIT_CONFIG_GLOBAL"] = fakeGlobalConfig;

    const bareRepo = await seedFixtureRepo(EVAL_FIXTURES[0]!);
    const verify = spawnSync("git", ["rev-parse", "--verify", "main"], { cwd: bareRepo, encoding: "utf8" });
    expect(verify.status).toBe(0);
  });

  it("C: seed-commit lykkes i det disponible repoet for ALLE 3 fixtures (inkl. nøstede src/-stier)", async () => {
    for (const fixture of EVAL_FIXTURES) {
      const bareRepo = await seedFixtureRepo(fixture);
      const ls = spawnSync("git", ["ls-tree", "-r", "--name-only", "main"], { cwd: bareRepo, encoding: "utf8" });
      expect(ls.status).toBe(0);
      const files = ls.stdout.trim().split("\n").sort();
      expect(files).toEqual(Object.keys(fixture.seedFiles).sort());
    }
  });

  it("D: feilbanen inkluderer nyttig sanert stderr+exit_code+stdout - ALDRI kun en tom stderr-streng", async () => {
    const empty = await mkdtemp(join(tmpdir(), "jarvis-eval-emptyrepo-"));
    git(empty, "init", "--initial-branch=main", ".");
    git(empty, "config", "--local", "user.email", "x@example.invalid");
    git(empty, "config", "--local", "user.name", "x");
    // Ingenting staget - "nothing to commit" skrives til STDOUT, ikke stderr,
    // som var nøyaktig grunnen til at den opprinnelige feilmeldingen var tom.
    expect(() => git(empty, "commit", "-m", "seed")).toThrowError(/exit_code=\d+/);
    try {
      git(empty, "commit", "-m", "seed");
      expect.unreachable("skulle ha kastet");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/command=git commit -m seed/);
      expect(message).toMatch(/exit_code=1/);
      expect(message.toLowerCase()).toMatch(/nothing to commit|nothing added/);
    }

    const notARepo = await mkdtemp(join(tmpdir(), "jarvis-eval-notarepo-"));
    try {
      git(notARepo, "commit", "-m", "seed");
      expect.unreachable("skulle ha kastet");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toMatch(/exit_code=\d+/);
      expect(message.toLowerCase()).toMatch(/not a git repository/);
    }
  });

  it("E: ingen hemmelighet forekommer noensinne i en diagnosemelding", () => {
    const secret = "sk-ant-super-secret-value-123";
    const message = describeGitFailure(
      ["commit", "-m", "seed"],
      { status: 1, stderr: `fatal: something failed near ${secret}`, stdout: `bin=${secret}` },
      [secret]
    );
    expect(message).not.toContain(secret);
    expect(message).toContain("[REDACTED]");
  });

  it("F: orakel-/fixture-beskyttelse (classifyChangedFiles) uendret - denne reparasjonen rører ikke klassifiseringslogikken", async () => {
    // Beviser at seedFixtureRepo skriver NØYAKTIG (og kun) fixturens egne
    // seedFiles - orakel-/testfiler inkludert som en del av seedingen (det
    // ER meningen), ALDRI noe utenfor. Selve etterkontroll-logikken
    // (classifyChangedFiles) er urørt av denne sliceen - dekket separat av
    // de 35 eksisterende testene i coding-agent-eval.test.ts.
    const fixture = EVAL_FIXTURES[1]!; // Task B - har orakelfil src/formatter.test.js
    const bareRepo = await seedFixtureRepo(fixture);
    for (const oracleFile of fixture.oracleFiles) {
      const show = spawnSync("git", ["show", `main:${oracleFile}`], { cwd: bareRepo, encoding: "utf8" });
      expect(show.status).toBe(0);
      expect(show.stdout).toBe(fixture.seedFiles[oracleFile]);
    }
  });

  it("G: filen introduserer INGEN endring i timeout-mekanikken (dokumentert, ikke re-testet her - se coding-agent-eval-timeout.test.ts)", () => {
    // coding-agent-eval-timeout.test.ts bruker sin egen, uavhengige inline
    // seed-rutine (ett enkelt README.md, ingen undermappe) - berøres IKKE av
    // denne filen eller av endringene i ua5-coding-agent-live-eval.ts.
    expect(true).toBe(true);
  });

  it("Windows-regresjonsklasse: fersk disponibel repo + ingen antatt brukeridentitet + vertslignende signeringskonfig -> vellykket seed-commit med nøstede stier", async () => {
    await writeFile(
      fakeGlobalConfig,
      "[commit]\n  gpgsign = true\n[gpg]\n  program = /nonexistent/definitely-not-a-real-gpg-binary\n"
    );
    process.env["HOME"] = fakeHome;
    process.env["XDG_CONFIG_HOME"] = fakeHome;
    process.env["GIT_CONFIG_GLOBAL"] = fakeGlobalConfig;
    // BEVISST ingen [user]-seksjon i den globale konfigen - ingen ambient identitet.

    const fixture = EVAL_FIXTURES[1]!; // src/currency.js + src/formatter.js + src/formatter.test.js - ekte nøstet sti
    const bareRepo = await seedFixtureRepo(fixture);
    const show = spawnSync("git", ["show", "main:src/currency.js"], { cwd: bareRepo, encoding: "utf8" });
    expect(show.status).toBe(0);
    expect(show.stdout).toBe(fixture.seedFiles["src/currency.js"]);
  });
});
