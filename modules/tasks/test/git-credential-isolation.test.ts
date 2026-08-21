import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GIT_ASKPASS_TOKEN_ENV, GIT_CREDENTIAL_ISOLATION_ARGS, createGitAuthHandle } from "@jarvis/tasks";
import { type GitSmartHttpServer, startGitSmartHttpServer } from "./support/git-smart-http-server.ts";

/**
 * D-103 HOST-FIX (2026-08-21, "d103-host-git-auth-isolation-repair"): en ekte
 * Windows host-akseptanse (task d103-host-acceptance-986f37e6, worker
 * worker-903f4a30) viste at `push` autentiserte som "post-ops" i stedet for
 * den tiltenkte `JARVIS_GITHUB_TOKEN`-identiteten, til tross for at et gyldig
 * token med push/admin-tilgang var korrekt satt. Root cause (se full
 * begrunnelse i git-auth.ts): git sin credential-subsystem spør ALLTID
 * konfigurerte `credential.helper`-kjeder (system+global+repo, akkumulert)
 * FØR `GIT_ASKPASS` i det hele tatt konsulteres. Windows Git for Windows
 * registrerer typisk Git Credential Manager i den SYSTEM-nivå gitconfig-en
 * (`C:\Program Files\Git\etc\gitconfig`) - en fil git ALLTID leser
 * UAVHENGIG av `HOME`/`USERPROFILE` (og dermed uavhengig av at
 * `ProcessSandboxRunner` allerede gir clone/push et rent, HOME-fritt
 * prosess-env - den beskyttelsen var ALDRI tilstrekkelig mot en system-nivå
 * ambient helper).
 *
 * Denne test-filen reproduserer AKKURAT denne mekanismen mot en EKTE lokal
 * git smart-HTTP-server (`git http-backend`, se support/git-smart-http-
 * server.ts) - IKKE lokale bare-repo-filsti-kloner (som ALDRI trigger
 * credential-oppløsning i det hele tatt, se øvrige D-103-testfiler). Den
 * "ambiente" system-konfigurasjonen simuleres via `GIT_CONFIG_SYSTEM`
 * (git >= 2.32, overstyrer HVILKEN fil git behandler som system-config) -
 * ALDRI ved å mutere den EKTE system/global git-configen på denne maskinen.
 * Bruker de EKTE eksporterte produksjonsprimitivene (`createGitAuthHandle()`,
 * `GIT_CREDENTIAL_ISOLATION_ARGS`) direkte - AT `coding.ts` faktisk bruker
 * DISSE primitivene i riktig argv-posisjon/env-scope er separat bevist i
 * `coding-git-auth-wiring.test.ts` (tester A/B/K); DENNE filen beviser at
 * primitivene, når git FAKTISK utfører clone/push med dem mot en ekte
 * transport under trussel fra en ambient helper, produserer det RIKTIGE
 * utfallet.
 */

const JARVIS_TOKEN = "jarvis-d103-hostfix-test-token-never-real";
const AMBIENT_USER = "post-ops";
const AMBIENT_PASS = "ambient-wrong-secret-never-jarvis";
const JARVIS_ASKPASS_USER = "x-access-token";

function git(cwd: string, env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 20_000 });
}

/**
 * `spawnSync()` blokkerer via en INTERN libuv-løkke, ikke den vanlige Node
 * event-loopen - den asynkrone "AUTH:<user>"-linjen serveren (en HELT SEPARAT
 * barneprosess) skriver til SIN stdout, blir derfor IKKE nødvendigvis lest av
 * `git-smart-http-server.ts` sin `stdout.on("data", ...)`-lytter FØR selve
 * `spawnSync()`-kallet returnerer - kun FØR neste event-loop-tick. Ett
 * `setImmediate()` er nok til å garantere den er lest (OS-pipen har allerede
 * mottatt bytene mens vi ventet synkront; det er BARE selve JS-callbacken som
 * ikke har kjørt ennå).
 */
function flushServerLog(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 100));
}

async function writeFakeAmbientSystemConfig(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-ambient-"));
  const helperPath = join(dir, "fake-ambient-helper.sh");
  await writeFile(helperPath, [
    "#!/bin/sh",
    "# Simulerer Windows Git Credential Manager: returnerer en cached, ANNEN",
    "# (feil) identitet enn Jarvis sin, UANSETT hvilket repo/host som spørres.",
    'if [ "$1" = "get" ]; then',
    `  echo "username=${AMBIENT_USER}"`,
    `  echo "password=${AMBIENT_PASS}"`,
    "fi",
    ""
  ].join("\n"), "utf8");
  await chmod(helperPath, 0o700);
  const configPath = join(dir, "fake-system-gitconfig");
  await writeFile(configPath, `[credential]\n\thelper = ${helperPath}\n`, "utf8");
  return configPath;
}

describe("D-103 HOST-FIX: ambient credential.helper kan IKKE kapre Jarvis sin eksplisitte git-auth", () => {
  let server: GitSmartHttpServer;
  let fakeSystemConfig: string;
  const baseEnv = () => ({ PATH: process.env["PATH"] ?? "", GIT_TERMINAL_PROMPT: "0" });

  beforeAll(async () => {
    // Aksepterer BEGGE identiteter (som en ekte GitHub-server ville - "post-ops"
    // ER en gyldig, autentiserbar bruker, bare IKKE den Jarvis skal bruke) - selve
    // testens signal er HVILKEN identitet som faktisk ble sendt, ikke bare pass/fail.
    server = await startGitSmartHttpServer([
      { user: AMBIENT_USER, pass: AMBIENT_PASS },
      { user: JARVIS_ASKPASS_USER, pass: JARVIS_TOKEN }
    ]);
    server.createBareRepo("repo.git");
    const seed = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-seed-"));
    git(seed, { ...process.env, HOME: seed }, "init", "--initial-branch=main", ".");
    git(seed, { ...process.env, HOME: seed }, "config", "user.email", "seed@test");
    git(seed, { ...process.env, HOME: seed }, "config", "user.name", "seed");
    await writeFile(join(seed, "README.md"), "# repo\n", "utf8");
    git(seed, { ...process.env, HOME: seed }, "add", "-A");
    git(seed, { ...process.env, HOME: seed }, "commit", "-m", "init");
    // Seedes via LOKAL filsti-push (ALDRI via HTTP-serveren selv, ALDRI via nettverk) -
    // den EKTE testen (clone/push MOT den ekte HTTP-serveren) skjer utelukkende i
    // testene B-E under. Dette er ren fixture-oppsett, uavhengig av selve mekanismen
    // som testes.
    const seedPush = git(seed, { ...process.env, HOME: seed }, "push", join(server.reposRoot, "repo.git"), "main");
    if (seedPush.status !== 0) throw new Error(`seed-push feilet: ${seedPush.stderr}`);

    fakeSystemConfig = await writeFakeAmbientSystemConfig();
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  it("A: FORUTSETNING - den ambiente helperen returnerer en SYNTAKTISK GYLDIG, AUTENTISERBAR, men ANNEN identitet enn Jarvis sin ('post-ops' != 'x-access-token')", () => {
    // git credential fill leser protocol/host fra stdin - gi den et minimalt gyldig oppslag:
    const filled = spawnSync("git", ["credential", "fill"], {
      env: { PATH: process.env["PATH"] ?? "", GIT_CONFIG_SYSTEM: fakeSystemConfig },
      input: "protocol=http\nhost=127.0.0.1\n\n",
      encoding: "utf8"
    });
    expect(filled.stdout).toContain(`username=${AMBIENT_USER}`);
    expect(filled.stdout).not.toContain(JARVIS_ASKPASS_USER);
  });

  it("B: UTEN isolasjonsflagget ville ambient helper VUNNET (pre-fix-sårbarhet reprodusert nøyaktig) - serveren ser 'post-ops', ALDRI Jarvis sin askpass-identitet", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-clone-b-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const before = server.authenticatedUsernames.length;
      // BEVISST UTEN GIT_CREDENTIAL_ISOLATION_ARGS - reproduserer EKSAKT
      // pre-D-103-HOST-FIX argv (kun "clone", ingen "-c credential.helper=").
      git(dir, env, "clone", server.url("repo.git"), ".");
      await flushServerLog();
      // Én git-prosess kan gjøre flere autentiserte HTTP-forespørsler (GET
      // info/refs + POST upload-pack) - alle skal likevel bære SAMME (her:
      // den ambiente) identitet, aldri en blanding.
      const thisTest = server.authenticatedUsernames.slice(before);
      expect(thisTest.length).toBeGreaterThan(0);
      expect(thisTest.every((u) => u === AMBIENT_USER)).toBe(true);
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("C: MED isolasjonsflagget (den EKTE fiksen) vinner Jarvis sin askpass-identitet, ALDRI ambient - clone lykkes mot en ekte, kontrollert git-transport", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-clone-c-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const before = server.authenticatedUsernames.length;
      const result = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, "clone", server.url("repo.git"), ".");
      await flushServerLog();
      expect(result.status).toBe(0);
      const thisTest = server.authenticatedUsernames.slice(before);
      expect(thisTest.length).toBeGreaterThan(0);
      expect(thisTest.every((u) => u === JARVIS_ASKPASS_USER)).toBe(true);
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("D: push lykkes OGSÅ mot en ekte, kontrollert git-transport MED isolasjonsflagget - identitet forblir Jarvis sin, ALDRI ambient, gjennom BEGGE nettverkskall (clone OG push)", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-push-d-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const before = server.authenticatedUsernames.length;
      const cloneResult = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, "clone", server.url("repo.git"), ".");
      expect(cloneResult.status).toBe(0);
      git(dir, { ...env, HOME: dir }, "config", "user.email", "jarvis@test");
      git(dir, { ...env, HOME: dir }, "config", "user.name", "jarvis");
      await writeFile(join(dir, "CHANGES.md"), "endret av D-103 host-fix-test\n", "utf8");
      git(dir, env, "add", "-A");
      git(dir, env, "commit", "-m", "test change");
      const branch = `jarvis/d103-hostfix-test-${Date.now()}`;
      const pushResult = git(dir, env, ...GIT_CREDENTIAL_ISOLATION_ARGS, "push", "origin", `main:${branch}`);
      await flushServerLog();
      expect(pushResult.status).toBe(0);
      // BEGGE kall (clone-fasen OG push-fasen, hver sin egen git-prosess-invokering
      // med sin egen credential-oppløsningsrunde) skal ha brukt Jarvis sin identitet -
      // KUN denne testens egne forespørsler (fra `before`), ALDRI tidligere testers.
      const thisTest = server.authenticatedUsernames.slice(before);
      expect(thisTest).not.toContain(AMBIENT_USER);
      expect(thisTest.filter((u) => u === JARVIS_ASKPASS_USER).length).toBeGreaterThanOrEqual(2);
    } finally {
      await gitAuth.cleanup();
    }
  });

  it("E: token finnes ALDRI i argv, remote-URL eller resulterende git config gjennom HELE denne flyten (clone+commit+push, MED isolasjonsflagget)", async () => {
    const gitAuth = await createGitAuthHandle(JARVIS_TOKEN);
    try {
      const dir = await mkdtemp(join(tmpdir(), "jarvis-gitauth-hostfix-secrecy-e-"));
      const env = { ...baseEnv(), GIT_CONFIG_SYSTEM: fakeSystemConfig, ...gitAuth.env };
      const cloneArgs = [...GIT_CREDENTIAL_ISOLATION_ARGS, "clone", server.url("repo.git"), "."];
      const cloneResult = git(dir, env, ...cloneArgs);
      expect(cloneResult.status).toBe(0);
      for (const arg of cloneArgs) expect(arg).not.toContain(JARVIS_TOKEN);
      const configResult = git(dir, env, "config", "--get", "remote.origin.url");
      expect(configResult.stdout).not.toContain(JARVIS_TOKEN);
      expect(gitAuth.env[GIT_ASKPASS_TOKEN_ENV]).toBe(JARVIS_TOKEN); // token finnes KUN her, i env - ikke argv/config
    } finally {
      await gitAuth.cleanup();
    }
  });
});
