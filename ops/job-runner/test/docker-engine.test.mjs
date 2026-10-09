import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDockerExec } from "../lib/docker.mjs";
import { buildJobContainerCreateArgs } from "../lib/spec.mjs";
import { startFakeEngine } from "./support/fake-engine.mjs";
import { createHarness, IMAGE_ID } from "./support/harness.mjs";

/**
 * WP-C1 (D-32 port 2-8): runnerens HELE docker-kjede kjørt gjennom den EKTE Docker-CLI-en mot en FALSK Engine API (Unix-socket). Fake-docker-testene viser hva runneren SENDER til
 * `docker`, og `docker-cli-argv.test.mjs` at den ekte CLI-en PARSER flaggene; her leser vi HVILKEN containerkonfigurasjon den ekte CLI-en gjør flaggene om til - akkurat det daemonen
 * ville fått (privileged, capabilities, mounts, minne, nettverk, env, exec-kommando ...). Hoppes over uten `docker`-binær.
 *
 * ÆRLIGHET: dette er IKKE bevis for at en ekte daemon starter eller isolerer containeren (cgroups, seccomp, nettverk, tmpfs-håndheving, OOM) - det er `ops/job-runner/acceptance.sh`
 * (J03-J10) på verten. Og `docker exec`s output-strøm (kapret forbindelse) er ikke emulert: exec-KONFIGURASJONEN fanges, så avslutter CLI-en med feil.
 */

const which = spawnSync("sh", ["-c", "command -v docker"], { encoding: "utf8" });
const DOCKER_BIN = which.stdout.trim();
const HAS_DOCKER = which.status === 0 && DOCKER_BIN.startsWith("/");

const SECRET = "sk-ant-api03-MOTOR-TEST-IKKE-EN-EKTE-NOKKEL-0123456789";

/** @type {Array<() => Promise<void>>} */
let cleanups = [];
afterEach(async () => {
  for (const c of cleanups.reverse()) await c().catch(() => undefined);
  cleanups = [];
});

async function realDocker(engine) {
  const home = await mkdtemp(join(tmpdir(), "jr-dockerhome-"));
  const real = createDockerExec({
    dockerBin: DOCKER_BIN,
    baseEnv: { PATH: "/usr/bin:/bin:/usr/local/bin", HOME: home, DOCKER_CONFIG: home, DOCKER_HOST: `unix://${engine.socketPath}` }
  });
  /** @type {Array<{ args: string[], envKeys: string[], envValues: string[] }>} */
  const calls = [];
  /** @type {import("../lib/docker.mjs").DockerExec} */
  const exec = (args, opts) => {
    calls.push({ args: [...args], envKeys: Object.keys(opts?.env ?? {}), envValues: Object.values(opts?.env ?? {}) });
    return real(args, opts);
  };
  return { exec, calls };
}

/** Nyere Docker-CLI-er serialiserer et utelatt felt som `[]`/`{}`/`""` der eldre utelater det (null/undefined). Sikkerhetsinnholdet er det samme: ingen oppføringer. */
const absentOrEmpty = (v) => v == null || (Array.isArray(v) ? v.length === 0 : typeof v === "object" ? Object.keys(v).length === 0 : v === "");

async function setup(runner = {}) {
  const engine = await startFakeEngine();
  cleanups.push(() => engine.stop());
  const docker = await realDocker(engine);
  const h = await createHarness({ dockerExec: docker.exec, runner });
  cleanups.push(() => h.close());
  return { engine, docker, h };
}

/** Alle strengverdier i et JSON-tre (for «finnes X noe sted i konfigurasjonen?»). */
function allStrings(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out);
  else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) { out.push(k); allStrings(v, out); }
  return out;
}

describe.skipIf(!HAS_DOCKER)("ekte Docker-CLI -> falsk Engine API: containerkonfigurasjonen daemonen ville fått", () => {
  it("kontroll: probeen ser faktisk hva CLI-en sender (et ekstra --privileged / -v blir synlig i konfigurasjonen)", async () => {
    const engine = await startFakeEngine();
    cleanups.push(() => engine.stop());
    const { exec } = await realDocker(engine);
    const base = { image: IMAGE_ID, network: "jarvis-jobs", egressProxyUrl: "http://172.30.77.1:3128", pull: /** @type {"never"} */ ("never") };
    const args = buildJobContainerCreateArgs(base, { containerName: "jarvis-job-123e4567-e89b-42d3-a456-426614174000", workdir: "/var/lib/x/work", envNames: [] });
    const bad = [args[0], "--privileged", "-v", "/var/run/docker.sock:/var/run/docker.sock", "--cap-add", "SYS_ADMIN", ...args.slice(1)];
    const r = await exec(bad, { timeoutMs: 30_000 });
    expect(r.status, r.stderr.toString("utf8")).toBe(0);
    const config = engine.find("POST", /^\/containers\/create$/)[0]?.body;
    expect(config.HostConfig.Privileged).toBe(true);
    expect(config.HostConfig.Binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock"]);
    expect(config.HostConfig.CapAdd).toEqual(["CAP_SYS_ADMIN"]); // CLI-en normaliserer navnet
  });

  it("opprett jobb: privileged=false, read-only rotfs, cap-drop ALL, no-new-privileges, ikke-root, minne/swap/CPU/PID-grenser, kun jobbnettverket, KUN /work montert, ingen docker.sock", async () => {
    const { engine, h } = await setup();
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: SECRET }, task_id: "task-42" });
    const created = engine.find("POST", /^\/containers\/create$/);
    expect(created).toHaveLength(1);
    const c = created[0].body;
    const host = c.HostConfig;
    // isolasjon
    expect(host.Privileged).toBe(false);
    expect(host.ReadonlyRootfs).toBe(true);
    expect(host.CapDrop).toEqual(["ALL"]);
    expect(absentOrEmpty(host.CapAdd), `host.CapAdd=${JSON.stringify(host.CapAdd)}`).toBe(true);
    expect(host.SecurityOpt).toEqual(["no-new-privileges:true"]);
    expect(c.User).toBe("10001:10001");
    expect(host.Init).toBe(true);
    // ressursgrenser (D-32 port 8)
    expect(host.Memory).toBe(1024 ** 3);
    expect(host.MemorySwap).toBe(1024 ** 3);
    expect(host.NanoCpus).toBe(1_000_000_000);
    expect(host.PidsLimit).toBe(256);
    // nettverk (D-32 port 9): kun det interne jobbnettverket, ingen porter, ingen egne DNS-/vertsoppføringer
    expect(host.NetworkMode).toBe("jarvis-jobs");
    expect(host.PortBindings).toEqual({});
    expect(host.PublishAllPorts).toBe(false);
    expect(absentOrEmpty(host.Dns), `host.Dns=${JSON.stringify(host.Dns)}`).toBe(true);
    expect(absentOrEmpty(host.ExtraHosts), `host.ExtraHosts=${JSON.stringify(host.ExtraHosts)}`).toBe(true);
    expect(host.PidMode).toBe("");
    expect(host.IpcMode).toBe("");
    expect(host.UsernsMode).toBe("");
    expect(host.UTSMode).toBe("");
    expect(host.CgroupnsMode).toBe("");
    expect(host.Devices).toEqual([]);
    expect(absentOrEmpty(host.DeviceRequests), `host.DeviceRequests=${JSON.stringify(host.DeviceRequests)}`).toBe(true);
    // filsystem (D-32 port 3-5): nøyaktig ÉN bind-mount (/work), ellers kun tmpfs; ingen Binds, ingen volumer, ingen docker.sock noe sted
    expect(host.Mounts).toEqual([{ Type: "bind", Source: join(h.baseDir, job.job_id, "work"), Target: "/work" }]);
    expect(absentOrEmpty(host.Binds), `host.Binds=${JSON.stringify(host.Binds)}`).toBe(true);
    expect(c.Volumes).toEqual({});
    expect(Object.keys(host.Tmpfs).sort()).toEqual(["/home/job", "/tmp"]);
    expect(host.Tmpfs["/tmp"]).toBe("rw,noexec,nosuid,nodev,size=256m");
    expect(host.Tmpfs["/home/job"]).toBe("rw,noexec,nosuid,nodev,size=256m,uid=10001,gid=10001");
    expect(allStrings(c).filter((x) => /docker\.sock|\/var\/run|\/etc\/|\/root|\/home\/(?!job)/.test(x))).toEqual([]);
    // identitet og merking
    expect(c.Image).toBe(IMAGE_ID);
    expect(c.Cmd).toEqual(["sleep", "infinity"]);
    expect(absentOrEmpty(c.Entrypoint), `c.Entrypoint=${JSON.stringify(c.Entrypoint)}`).toBe(true);
    expect(c.WorkingDir).toBe("/work");
    expect(c.Labels).toEqual({ "jarvis.role": "job", "jarvis.task_id": "task-42" });
    // env: proxy + HOME + git-identitet (konstanter) + EXAKT de navngitte jobb-variablene; INGEN credentials
    const env = Object.fromEntries(c.Env.map((e) => [e.slice(0, e.indexOf("=")), e.slice(e.indexOf("=") + 1)]));
    expect(env["ANTHROPIC_API_KEY"]).toBe(SECRET); // CLI-en leste verdien fra sitt EGET miljø (-e NAVN), ikke fra argv
    expect(env["HTTPS_PROXY"]).toBe("http://172.30.77.1:3128");
    expect(env["NO_PROXY"]).toBe("");
    expect(env["HOME"]).toBe("/home/job");
    expect(Object.keys(env).filter((k) => /TOKEN|PASSWORD|SECRET|ASKPASS|SSH_AUTH|GITHUB|GH_/i.test(k))).toEqual([]);
    expect(allStrings(c).filter((x) => x.includes(h.gitToken))).toEqual([]); // git-credentialen er ikke i containerkonfigurasjonen
    // og containeren ble startet
    expect(engine.find("POST", /^\/containers\/[^/]+\/start$/)).toHaveLength(1);
  }, 60_000);

  it("hemmeligheten står ikke i argv til noe docker-kall (kun i klientens EGET miljø for ett kall), og kun under det navngitte nøkkelnavnet", async () => {
    const { docker, h } = await setup();
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: SECRET } });
    await h.exec(job.job_id, ["sh", "-c", "true"]);
    await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(docker.calls.length).toBeGreaterThan(5);
    for (const call of docker.calls) expect(call.args.join("\u0000"), call.args[0]).not.toContain(SECRET);
    const withSecret = docker.calls.filter((c) => c.envValues.includes(SECRET));
    expect(withSecret.map((c) => c.args[0])).toEqual(["create"]); // kun create-kallet bar verdien
    expect(withSecret[0].envKeys).toEqual(["ANTHROPIC_API_KEY"]);
  }, 60_000);

  it("exec med fiendtlig argv: alt etter containernavnet havner ordrett i Cmd; Privileged=false, ingen User-overstyring, ingen TTY/stdin, WorkingDir=/work, kun navngitt env", async () => {
    const { engine, h } = await setup();
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: SECRET } });
    const hostile = ["sh", "--privileged", "--user=0", "-u", "root", "-e", "A=B", "--workdir=/", "--env-file=/etc/shadow", "-c", "id; $(reboot) `reboot` && rm -rf / ; --", "\n--bogus-flag"];
    const r = await h.exec(job.job_id, hostile, { env: { CI: "1" } });
    expect(r.status, r.text).toBe(200); // runneren svarer; CLI-en feiler til slutt fordi exec/start (kapret forbindelse) ikke er emulert
    const execs = engine.find("POST", /^\/containers\/[^/]+\/exec$/);
    expect(execs).toHaveLength(1);
    const cfg = execs[0].body;
    expect(cfg.Cmd).toEqual(hostile);
    expect(cfg.Privileged).toBe(false);
    expect(cfg.User).toBe("");
    expect(cfg.Tty).toBe(false);
    expect(cfg.AttachStdin).toBe(false);
    expect(cfg.WorkingDir).toBe("/work");
    expect(cfg.Env).toEqual(["CI=1"]);
    expect(cfg.DetachKeys).toBe("");
    // Nyere Docker-CLI-er sender i tillegg `Detach` (false for en tilknyttet exec). Nøkkelsettet ellers er låst; `Detach` tillates kun som false/utelatt (true ville frikoblet prosessen fra runneren).
    expect(cfg.Detach === undefined || cfg.Detach === false, `Detach=${String(cfg.Detach)}`).toBe(true);
    expect(Object.keys(cfg).filter((k) => k !== "Detach").sort()).toEqual(["AttachStderr", "AttachStdin", "AttachStdout", "Cmd", "DetachKeys", "Env", "Privileged", "Tty", "User", "WorkingDir"]);
    // containernavnet i URL-en er runnerens eget
    expect(execs[0].path).toBe(`/containers/jarvis-job-${job.job_id}/exec`);
  }, 60_000);

  it("DELETE: docker rm -f -v mot NØYAKTIG jobbens container (force + volumer), og oppstartsavstemmingen finner/fjerner kun containere merket jarvis.role=job", async () => {
    const { engine, h } = await setup();
    // en fremmed container (ikke merket) og en gammel jobb-container fra en «krasjet» kjøring
    engine.containers.set("annen-tjeneste", { id: "ff", name: "annen-tjeneste", config: { Labels: {} }, running: true });
    engine.containers.set("jarvis-job-11111111-1111-4111-8111-111111111111", { id: "ee", name: "jarvis-job-11111111-1111-4111-8111-111111111111", config: { Labels: { "jarvis.role": "job" } }, running: true });
    const job = await h.createJob();
    const del = await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(del.json).toEqual({ deleted: true, state: "gone" });
    const deletes = engine.find("DELETE", /^\/containers\//);
    expect(deletes).toHaveLength(1);
    expect(deletes[0].path).toBe(`/containers/jarvis-job-${job.job_id}`);
    expect(deletes[0].query.get("force")).toMatch(/^(1|true)$/);
    expect(deletes[0].query.get("v")).toMatch(/^(1|true)$/);
    // avstemming (ny runner-instans mot samme motor): den gamle jobb-containeren fjernes, den fremmede røres ikke
    const h2 = await createHarness({ dockerExec: (await realDocker(engine)).exec });
    cleanups.push(() => h2.close());
    expect(engine.containers.has("jarvis-job-11111111-1111-4111-8111-111111111111")).toBe(false);
    expect(engine.containers.has("annen-tjeneste")).toBe(true);
  }, 60_000);

  it("jobbnettverket må være --internal: motoren melder Internal=false -> oppstart nektes (503-kodene er stabile), og før hver jobb", async () => {
    const engine = await startFakeEngine();
    cleanups.push(() => engine.stop());
    const docker = await realDocker(engine);
    engine.state.internal = false;
    await expect(createHarness({ dockerExec: docker.exec })).rejects.toMatchObject({ code: "job_network_not_internal" });
    engine.state.internal = true;
    const h = await createHarness({ dockerExec: docker.exec });
    cleanups.push(() => h.close());
    engine.state.internal = false; // omkonfigurert mens tjenesten kjører
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("job_network_not_internal");
    expect(engine.find("POST", /^\/containers\/create$/)).toHaveLength(0);
  }, 60_000);
});
