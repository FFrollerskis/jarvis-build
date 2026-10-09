import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildJobContainerCreateArgs } from "../lib/spec.mjs";

/**
 * WP-C1: argv-et runneren sender til `docker create` blir PARSET av den ekte Docker-CLI-en (uten daemon). Fake-docker-testene beviser hva
 * runneren SENDER; denne beviser at ekte `docker` godtar flaggene og verdiformatene (`--tmpfs`, `--mount`, `--memory`, `--cpus`, `--user`...) og
 * ikke f.eks. avviser ett av dem som ukjent. Uten en daemon feiler kommandoen ALLTID til slutt med «kan ikke koble til» - men KUN etter at
 * flaggene er parset; en parse-feil gir en annen melding («unknown flag», «invalid argument»). Positive kontroller under viser at probeen faktisk
 * oppdager parse-feil. Hoppes over hvis `docker` ikke finnes (CI uten Docker). Dette er IKKE bevis for at containeren starter eller isolerer.
 */

const probe = spawnSync("docker", ["--version"], { encoding: "utf8" });
const HAS_DOCKER = !probe.error && probe.status === 0;

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const base = { image: IMAGE_ID, network: "jarvis-jobs", egressProxyUrl: "http://172.30.77.1:3128", pull: /** @type {"never"} */ ("never") };
const job = { containerName: "jarvis-job-123e4567-e89b-42d3-a456-426614174000", workdir: "/var/lib/jarvis-job-runner/jobs/x/work", envNames: ["ANTHROPIC_API_KEY"], taskId: "task-1" };

/** Kjører `docker <args>` mot en daemon som ikke finnes; returnerer {parsed, stderr}. */
async function dockerParses(args) {
  const config = await mkdtemp(join(tmpdir(), "wpc1-dockercfg-"));
  const r = spawnSync("docker", args, {
    encoding: "utf8", timeout: 30_000,
    env: { PATH: process.env["PATH"], HOME: config, DOCKER_CONFIG: config, DOCKER_HOST: "unix:///nonexistent-jarvis-wpc1.sock", ANTHROPIC_API_KEY: "ikke-en-ekte-nokkel" }
  });
  const stderr = `${r.stderr ?? ""}`;
  const parseError = /unknown flag|unknown shorthand|invalid argument|invalid reference format|invalid mount|invalid tmpfs|invalid value|requires at least|unknown option|Usage:\s+docker create/i.test(stderr);
  const reachedDaemon = /failed to connect to the docker API|Cannot connect to the Docker daemon|no such file or directory|connect:/i.test(stderr);
  return { parsed: !parseError && reachedDaemon, parseError, reachedDaemon, stderr: stderr.slice(0, 400) };
}

describe.skipIf(!HAS_DOCKER)("ekte Docker-CLI parser argv-et fra den delte container-spesifikasjonen", () => {
  it("kontroll 1: probeen oppdager ukjente flagg", async () => {
    const r = await dockerParses([...buildJobContainerCreateArgs(base, job).slice(0, 1), "--bogus-flag-fra-test", ...buildJobContainerCreateArgs(base, job).slice(1)]);
    expect(r.parseError, r.stderr).toBe(true);
    expect(r.stderr).toMatch(/unknown flag/i);
  });

  it("kontroll 2: probeen oppdager ugyldige verdier (--memory 1x)", async () => {
    const args = buildJobContainerCreateArgs(base, job);
    const i = args.indexOf("--memory");
    const broken = [...args.slice(0, i + 1), "1x", ...args.slice(i + 2)];
    const r = await dockerParses(broken);
    expect(r.parseError, r.stderr).toBe(true);
    expect(r.stderr).toMatch(/invalid argument/i);
  });

  it("standardpolicy: alle flagg og verdiformater parses (kommandoen når fram til daemon-tilkoblingen)", async () => {
    const r = await dockerParses(buildJobContainerCreateArgs(base, job));
    expect(r.parsed, r.stderr).toBe(true);
  });

  it("annen ressurs-/brukerpolicy og digest-pinnet image-referanse parses også", async () => {
    const policy = { ...base, image: `registry.example/jarvis-job@sha256:${"b".repeat(64)}`, user: "1001:1002", memory: "512m", cpus: "0.5", pidsLimit: 128, tmpfsSize: "64m" };
    const r = await dockerParses(buildJobContainerCreateArgs(policy, { ...job, envNames: ["ANTHROPIC_API_KEY", "CI", "TZ"], fixedEnv: { GIT_AUTHOR_NAME: "jarvis worker", GIT_AUTHOR_EMAIL: "worker@jarvis.local" } }));
    expect(r.parsed, r.stderr).toBe(true);
  });

  it("`--pull never` er et ekte docker-flagg i denne CLI-versjonen (runneren bruker lokalt image, aldri registeret)", async () => {
    const args = buildJobContainerCreateArgs(base, job);
    expect(args.slice(args.indexOf("--pull"), args.indexOf("--pull") + 2)).toEqual(["--pull", "never"]);
    expect((await dockerParses(args)).parsed).toBe(true);
  });
});
