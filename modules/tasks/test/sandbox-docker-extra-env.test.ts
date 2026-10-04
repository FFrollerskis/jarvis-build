import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DockerSandboxRunner } from "../src/sandbox.ts";

/**
 * D-103 HOST-FIX v2: en tidligere closeout-audit flagget at
 * `DockerSandboxRunner.exec()` aksepterte en `extraEnv`-parameter men ALDRI
 * koblet den inn i selve `docker run`-kallet - som ville gjort autentiserte
 * kodejobber under `JARVIS_SANDBOX=docker` (eksplisitt opt-in, IKKE
 * produksjonsdefault - `ProcessSandboxRunner` er fortsatt default) STILLE
 * ute av stand til å autentisere (containeren fikk aldri credential-
 * helper-tokenet). Fikset ved: (1) å legge til `-e <NAVN>` (BAR form, ALDRI
 * `-e NAVN=VERDI`) til `docker run`-argv for hver `extraEnv`-nøkkel, (2) å
 * sende verdiene via `docker`-CLI-underprosessens EGEN env (`spawnSync`s
 * `env`-opsjon) - dockers dokumenterte `-e NAVN`-syntaks (uten `=`)
 * videresender verdien fra SIN EGEN prosess-env, så selve verdien vises
 * ALDRI i argv/prosesslisten.
 *
 * Denne testen bruker en FAKE `docker`-kjørbar fil (ALDRI en ekte Docker-
 * daemon) som registrerer sin egen mottatte argv + de env-verdiene den selv
 * kan se - beviser koblingen uten å kreve at Docker er installert i CI.
 */
describe("D-103 HOST-FIX v2: DockerSandboxRunner extraEnv-koblingsgap reparert", () => {
  async function writeFakeDocker(): Promise<{ dockerBin: string; recordPath: string }> {
    const dir = await mkdtemp(join(tmpdir(), "jarvis-fake-docker-"));
    const recordPath = join(dir, "record.json");
    const dockerBin = join(dir, "docker.cjs");
    await writeFile(dockerBin, [
      "#!/usr/bin/env node",
      "const fs = require(\"fs\");",
      "const args = process.argv.slice(2);",
      "const envNames = args.filter((a, i) => args[i - 1] === \"-e\");",
      "const envValues = {};",
      "for (const name of envNames) envValues[name] = process.env[name];",
      `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args, envValues }));`,
      "process.exit(0);"
    ].join("\n"), "utf8");
    await chmod(dockerBin, 0o700);
    return { dockerBin, recordPath };
  }

  it("A: extraEnv-nøkler blir bare '-e <NAVN>'-argv-elementer - verdien vises ALDRI i selve argv", async () => {
    const { dockerBin, recordPath } = await writeFakeDocker();
    const runner = new DockerSandboxRunner("node:22-alpine", dockerBin);
    const sandbox = await runner.create();
    const secretValue = "super-secret-token-never-in-argv";
    await sandbox.exec("echo", ["hi"], undefined, { JARVIS_GIT_CREDENTIAL_TOKEN: secretValue });
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[]; envValues: Record<string, string> };
    expect(record.args).toContain("-e");
    expect(record.args).toContain("JARVIS_GIT_CREDENTIAL_TOKEN");
    for (const arg of record.args) {
      expect(arg).not.toContain(secretValue);
    }
    await sandbox.dispose();
  });

  it("B: docker-CLI-underprosessens EGEN env bærer faktisk verdien (mekanismen '-e <NAVN>' er avhengig av)", async () => {
    const { dockerBin, recordPath } = await writeFakeDocker();
    const runner = new DockerSandboxRunner("node:22-alpine", dockerBin);
    const sandbox = await runner.create();
    const secretValue = "super-secret-token-value-b";
    await sandbox.exec("echo", ["hi"], undefined, { JARVIS_GIT_CREDENTIAL_TOKEN: secretValue });
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[]; envValues: Record<string, string> };
    expect(record.envValues["JARVIS_GIT_CREDENTIAL_TOKEN"]).toBe(secretValue);
    await sandbox.dispose();
  });

  it("C: uten extraEnv legges INGEN '-e'-flagg til i det hele tatt - default-oppførsel 100% uendret", async () => {
    const { dockerBin, recordPath } = await writeFakeDocker();
    const runner = new DockerSandboxRunner("node:22-alpine", dockerBin);
    const sandbox = await runner.create();
    await sandbox.exec("echo", ["hi"]);
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[] };
    expect(record.args).not.toContain("-e");
    await sandbox.dispose();
  });

  it("D: flere extraEnv-nøkler (f.eks. GIT_TERMINAL_PROMPT + token) får hver sitt eget '-e <NAVN>'-par", async () => {
    const { dockerBin, recordPath } = await writeFakeDocker();
    const runner = new DockerSandboxRunner("node:22-alpine", dockerBin);
    const sandbox = await runner.create();
    await sandbox.exec("echo", ["hi"], undefined, { GIT_TERMINAL_PROMPT: "0", JARVIS_GIT_CREDENTIAL_TOKEN: "tok" });
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[] };
    expect(record.args.filter((a) => a === "-e").length).toBe(2);
    expect(record.args).toContain("GIT_TERMINAL_PROMPT");
    expect(record.args).toContain("JARVIS_GIT_CREDENTIAL_TOKEN");
    await sandbox.dispose();
  });

  it("E: et påfølgende kall UTEN extraEnv i SAMME sandbox-instans får INGEN '-e'-flagg - mekanismen er per-kall, ikke klebrig", async () => {
    const { dockerBin, recordPath } = await writeFakeDocker();
    const runner = new DockerSandboxRunner("node:22-alpine", dockerBin);
    const sandbox = await runner.create();
    await sandbox.exec("git", ["clone", "url", "."], undefined, { JARVIS_GIT_CREDENTIAL_TOKEN: "tok" });
    await sandbox.exec("git", ["status"]); // agent-formet lokalt kall, ingen extraEnv
    const record = JSON.parse(await readFile(recordPath, "utf8")) as { args: string[] };
    expect(record.args).not.toContain("-e");
    await sandbox.dispose();
  });
});
