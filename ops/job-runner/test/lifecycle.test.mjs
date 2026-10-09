import { lstat, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CancelToken, RunnerError } from "../lib/errors.mjs";
import { GIT_TOKEN, RUNNER_TOKEN, createHarness } from "./support/harness.mjs";

/**
 * WP-C1: livssyklus og robusthet (D-32 porter 1-8, 11, 12): container per jobb, grenser faktisk satt, kansellering dreper umiddelbart,
 * TTL, oppstartsavstemming, maks samtidige jobber uten kappløp, rydding som feiler holder plassen, ingen hemmeligheter i logg.
 */

const exists = (path) => lstat(path).then(() => true, () => false);
let harnesses = [];
const harness = async (options) => { const h = await createHarness(options); harnesses.push(h); return h; };
afterEach(async () => { await Promise.all(harnesses.map((h) => h.close())); harnesses = []; });

describe("A: container per jobb med alle grensene faktisk satt", () => {
  it("create -> network inspect, create, start; flagg, mount, merkelapper og identitet er riktige", async () => {
    const h = await harness();
    const before = h.fake.calls.length; // oppstartskall (version/network/ps) er ikke en del av jobben
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-HEMMELIG-VERDI-xyz" }, task_id: "task-42", tenant_id: "tenant-a" });
    const name = `jarvis-job-${job.job_id}`;
    expect(h.fake.calls.slice(before).map((c) => c.args[0])).toEqual(["network", "create", "start"]);

    const c = h.fake.containers.get(name);
    const flag = (f) => c.parsed.flags[f];
    expect(flag("--user")).toEqual(["10001:10001"]);
    expect(c.parsed.booleans.has("--read-only")).toBe(true);
    expect(flag("--cap-drop")).toEqual(["ALL"]);
    expect(flag("--security-opt")).toEqual(["no-new-privileges:true"]);
    expect(flag("--memory")).toEqual(["1g"]);
    expect(flag("--memory-swap")).toEqual(["1g"]);
    expect(flag("--pids-limit")).toEqual(["256"]);
    expect(flag("--cpus")).toEqual(["1.0"]);
    expect(flag("--network")).toEqual(["jarvis-jobs"]);
    expect(flag("--pull")).toEqual(["never"]);
    expect(c.image).toBe(`sha256:${"a".repeat(64)}`);
    expect(c.parsed.booleans.has("--privileged")).toBe(false);
    expect(c.labels).toMatchObject({ "jarvis.role": "job", "jarvis.task_id": "task-42" });
    // ingen docker.sock, ingen host-home, kun én mount: /work -> job/work
    expect(c.mounts).toEqual([{ source: join(h.baseDir, job.job_id, "work"), target: "/work" }]);
    expect(JSON.stringify(c.argv)).not.toContain("docker.sock");
    expect(c.argv.includes("-v") || c.argv.includes("--volume")).toBe(false);
    // identitet for `git commit` kommer som konstant env; proxy peker på egress-proxyen
    expect(c.env).toMatchObject({ GIT_AUTHOR_NAME: "jarvis-worker", GIT_COMMITTER_EMAIL: "worker@jarvis.local", HTTPS_PROXY: "http://172.30.77.1:3128", HOME: "/home/job" });
    expect(job).toMatchObject({ workdir: "/work", base_branch: "main" });
    expect(job.head_sha).toBe(h.origins["owner/repo"].head);
  });

  it("hemmelige env-VERDIER ligger i docker-prosessens env, ALDRI i argv; git-credentialen finnes ingen steder i docker-kallene", async () => {
    const h = await harness();
    const secret = "sk-ant-api03-HEMMELIG-VERDI-xyz";
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: secret } });
    await h.exec(job.job_id, ["true"], { env: { PER_CALL_SECRET: "per-call-hemmelig-verdi-123" } });
    const create = h.fake.calls.find((c) => c.args[0] === "create");
    expect(create.env.ANTHROPIC_API_KEY).toBe(secret);
    expect(create.args.join(" ")).not.toContain(secret);
    expect(create.args).toContain("ANTHROPIC_API_KEY"); // kun navnet
    const exec = h.fake.calls.find((c) => c.args[0] === "exec");
    expect(exec.env.PER_CALL_SECRET).toBe("per-call-hemmelig-verdi-123");
    expect(exec.args.join(" ")).not.toContain("per-call-hemmelig-verdi-123");
    for (const call of h.fake.calls) {
      expect(call.args.join(" ")).not.toContain(GIT_TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(GIT_TOKEN);
      expect(JSON.stringify(call.env)).not.toContain(RUNNER_TOKEN);
    }
    const c = h.fake.containers.get(`jarvis-job-${job.job_id}`);
    expect(JSON.stringify(c.env)).not.toContain(GIT_TOKEN);
  });

  it("arbeidsmappen: credential-fri klone uten origin, uten hooks/maler; private/ er IKKE montert og ligger utenfor /work", async () => {
    const h = await harness();
    const job = await h.createJob();
    const dir = join(h.baseDir, job.job_id);
    const work = join(dir, "work");
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(work)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "private"))).mode & 0o777).toBe(0o700);
    expect(await exists(join(work, "README.md"))).toBe(true);
    const config = await readFile(join(work, ".git", "config"), "utf8");
    expect(config).not.toContain(GIT_TOKEN);
    expect(config).not.toMatch(/\[remote /);
    expect(config).not.toContain(h.root); // ingen runner-privat sti lekker inn
    expect(config).not.toMatch(/credential/i);
    const hooks = await readdir(join(work, ".git", "hooks")).catch(() => []);
    expect(hooks).toEqual([]);
    expect(await exists(join(work, "private"))).toBe(false);
    // ingen credential igjen i det private repoet heller
    const baseConfig = await readFile(join(dir, "private", "base.git", "config"), "utf8");
    expect(baseConfig).not.toContain(GIT_TOKEN);
    expect(baseConfig).not.toMatch(/credential/i);
  });

  it("git-identiteten gjør at `git commit` virker i «containeren» uten global config", async () => {
    const h = await harness();
    const job = await h.createJob();
    const r = await h.exec(job.job_id, ["sh", "-c", "echo x > f.txt && git add -A && git commit -q -m t && git log -1 --format=%an,%ae"]);
    expect(r.json).toMatchObject({ code: 0, stdout: "jarvis-worker,worker@jarvis.local\n" });
  });
});

describe("B: exec", () => {
  it("resultat med kode/stdout/stderr; hemmeligheter agenten skriver ut maskeres; per-kall env når prosessen", async () => {
    const h = await harness();
    const secret = "sk-ant-api03-HEMMELIG-VERDI-xyz";
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: secret } });
    const r = await h.exec(job.job_id, ["sh", "-c", "echo \"key=$ANTHROPIC_API_KEY call=$CALL_VAR\"; echo err >&2; exit 3"], { env: { CALL_VAR: "kall-verdi-123456" } });
    expect(r.json.code).toBe(3);
    expect(r.json.stdout).toBe("key=[REDACTED] call=[REDACTED]\n");
    expect(r.json.stderr).toBe("err\n");
  });

  it("tidsavbrudd dreper HELE containeren; senere exec/publish feiler lukket (409 job_terminated)", async () => {
    const h = await harness();
    const job = await h.createJob();
    const started = Date.now();
    const r = await h.exec(job.job_id, ["sleep", "30"], { timeout_ms: 1000 });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.json).toMatchObject({ code: 124, timed_out: true });
    expect(r.json.stderr).toContain("job_exec_timeout");
    expect(h.fake.containers.size).toBe(0); // docker rm -f kjørt
    expect(h.fake.calls.some((c) => c.args[0] === "rm" && c.args.includes("-f"))).toBe(true);
    const after = await h.exec(job.job_id, ["true"]);
    expect(after.status).toBe(409);
    expect(after.json.error).toBe("job_terminated");
    const pub = await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/x" } });
    expect(pub.status).toBe(409);
    // DELETE rydder likevel katalogen
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).status).toBe(200);
    expect(await exists(join(h.baseDir, job.job_id))).toBe(false);
  }, 30_000);

  it("output-tak: stdout over grensen kuttes og merkes", async () => {
    const h = await harness({ runner: { max_output_bytes: 2048 } });
    const job = await h.createJob();
    const r = await h.exec(job.job_id, ["sh", "-c", "head -c 100000 /dev/zero | tr '\\0' 'x'"]);
    expect(r.json.truncated).toBe(true);
    expect(r.json.stdout.length).toBe(2048);
    expect(r.json.stderr).toContain("[output_truncated]");
  });

  it("kun én operasjon om gangen per jobb (409 job_busy), og parallelle jobber er uavhengige", async () => {
    const h = await harness();
    const a = await h.createJob();
    const b = await h.createJob();
    const slow = h.exec(a.job_id, ["sleep", "2"]);
    await new Promise((r) => setTimeout(r, 300));
    const busy = await h.exec(a.job_id, ["true"]);
    expect(busy.status).toBe(409);
    expect(busy.json.error).toBe("job_busy");
    expect((await h.exec(b.job_id, ["echo", "ok"])).json.stdout).toBe("ok\n");
    expect((await slow).json.code).toBe(0);
  }, 20_000);
});

describe("C: kansellering (DELETE) dreper containeren umiddelbart", () => {
  it("DELETE midt i en kjørende exec: prosessen drepes, containeren og katalogen er borte, exec-kallet avsluttes", async () => {
    const h = await harness();
    const job = await h.createJob();
    const running = h.exec(job.job_id, ["sleep", "60"]);
    await new Promise((r) => setTimeout(r, 400));
    expect(h.fake.containers.size).toBe(1);
    const t0 = Date.now();
    const del = await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(del.status).toBe(200);
    expect(del.json).toEqual({ deleted: true, state: "gone" });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(h.fake.containers.size).toBe(0);
    expect(await exists(join(h.baseDir, job.job_id))).toBe(false);
    const finished = await running;
    expect([409, 200]).toContain(finished.status); // job_cancelled (409) eller død prosess; aldri hengende
    expect(h.service.manager.activeJobs).toBe(0);
  }, 30_000);

  it("dobbel DELETE er idempotent; exec etter DELETE gir 404", async () => {
    const h = await harness();
    const job = await h.createJob();
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).json).toEqual({ deleted: true, state: "gone" });
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).json).toEqual({ deleted: false, state: "gone" });
    expect((await h.exec(job.job_id, ["true"])).status).toBe(404);
  });

  it("to samtidige DELETE på samme jobb: begge ender trygt, ingen dobbel-opprydding eller feil", async () => {
    const h = await harness();
    const job = await h.createJob();
    const [r1, r2] = await Promise.all([
      h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` }),
      h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect(h.fake.containers.size).toBe(0);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("rydding som feiler (docker henger) holder jobben som cleanup_pending (202) og plassen, og sweep() fullfører senere", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 1 } });
    const job = await h.createJob();
    h.fake.state.failRemove = true;
    const del = await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(del.status).toBe(202);
    expect(del.json).toEqual({ deleted: false, state: "cleanup_pending" });
    expect(h.service.manager.activeJobs).toBe(1);
    const blocked = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(blocked.status).toBe(429); // plassen er holdt
    expect(await exists(join(h.baseDir, job.job_id))).toBe(true); // katalogen beholdes så lenge containeren kanskje lever
    h.fake.state.failRemove = false;
    await h.service.manager.sweep();
    expect(h.service.manager.activeJobs).toBe(0);
    expect(await exists(join(h.baseDir, job.job_id))).toBe(false);
  });

  it("klient som kobler fra midt i en exec: containeren drepes (ingen foreldreløs jobb), jobben er terminated", async () => {
    const h = await harness();
    const job = await h.createJob();
    await new Promise((resolve) => {
      const req = http.request({ socketPath: h.socketPath, method: "POST", path: `/v1/jobs/${job.job_id}/exec`, headers: { authorization: `Bearer ${RUNNER_TOKEN}`, "content-type": "application/json" } });
      req.on("error", () => undefined);
      req.end(JSON.stringify({ argv: ["sleep", "60"] }));
      setTimeout(() => { req.destroy(); resolve(undefined); }, 400);
    });
    for (let i = 0; i < 50 && h.fake.containers.size > 0; i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(h.fake.containers.size).toBe(0);
    expect((await h.exec(job.job_id, ["true"])).status).toBe(409);
    expect((await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` })).status).toBe(200);
  }, 30_000);

  it("forhåndskansellert opprettelse (klient borte) avbryter og rydder uten spor", async () => {
    const h = await harness();
    const gone = new CancelToken();
    gone.cancel();
    await expect(h.service.manager.create({ repo: "owner/repo", env: {} }, gone)).rejects.toBeInstanceOf(RunnerError);
    expect(h.service.manager.activeJobs).toBe(0);
    expect((await readdir(h.baseDir)).filter((n) => n !== ".runner")).toEqual([]);
    expect(h.fake.containers.size).toBe(0);
  });
});

describe("D: maks samtidige jobber uten kappløp", () => {
  it("8 samtidige create med maks 2: NØYAKTIG 2 lykkes, 6 får 429; ny plass etter DELETE", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 2 } });
    const results = await Promise.all(Array.from({ length: 8 }, () => h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    expect(h.fake.containers.size).toBe(2);
    expect(h.service.manager.activeJobs).toBe(2);
    const ok = results.find((r) => r.status === 201);
    await h.api({ method: "DELETE", path: `/v1/jobs/${ok.json.job_id}` });
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })).status).toBe(201);
  }, 30_000);

  it("mislykket opprettelse frigjør plassen (ingen lekkasje av slots)", async () => {
    const h = await harness({ runner: { max_concurrent_jobs: 1 } });
    h.fake.state.failCreate = true;
    for (let i = 0; i < 3; i += 1) expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })).status).toBe(502);
    h.fake.state.failCreate = false;
    expect(h.service.manager.activeJobs).toBe(0);
    expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })).status).toBe(201);
  });
});

describe("E: TTL (maks levetid)", () => {
  it("jobber som har passert levetiden fjernes (container + katalog) av sweep(); yngre jobber røres ikke", async () => {
    let clock = 1_000_000;
    const h = await harness({ runner: { max_job_lifetime_s: 60 }, now: () => clock });
    const old = await h.createJob();
    clock += 30_000;
    const young = await h.createJob();
    clock += 31_000; // old = 61 s, young = 31 s
    await h.service.manager.sweep();
    expect(await exists(join(h.baseDir, old.job_id))).toBe(false);
    expect(await exists(join(h.baseDir, young.job_id))).toBe(true);
    expect(h.fake.containers.size).toBe(1);
    expect((await h.exec(old.job_id, ["true"])).status).toBe(404);
    clock += 60_000;
    await h.service.manager.sweep();
    expect(h.fake.containers.size).toBe(0);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("expires_at i create-svaret speiler policyen", async () => {
    const clock = Date.parse("2026-10-09T00:00:00.000Z");
    const h = await harness({ runner: { max_job_lifetime_s: 600 }, now: () => clock });
    expect((await h.createJob()).expires_at).toBe("2026-10-09T00:10:00.000Z");
  });
});

describe("F: oppstartsavstemming (D-32 port 12: crash/reclaim)", () => {
  it("fjerner containere merket jarvis.role=job og UUID-kataloger fra en krasjet kjøring; røper ikke ukjente oppføringer eller fremmede containere", async () => {
    const stale = "11111111-1111-4111-8111-111111111111";
    const h = await harness({
      beforeStart: async ({ baseDir, fake }) => {
        await mkdir(join(baseDir, stale, "work", "sub"), { recursive: true });
        await writeFile(join(baseDir, stale, "work", "sub", "agent.txt"), "rester");
        await mkdir(join(baseDir, "ikke-en-uuid"), { recursive: true });
        await writeFile(join(baseDir, "notes.txt"), "ikke rør");
        // «stale» container fra forrige kjøring + en FREMMED container uten vår merkelapp + en med feil navn
        fake.containers.set(`jarvis-job-${stale}`, { name: `jarvis-job-${stale}`, labels: { "jarvis.role": "job" }, mounts: [], env: {}, parsed: { flags: {}, booleans: new Set() }, started: true, source: "" });
        fake.containers.set("annen-tjeneste", { name: "annen-tjeneste", labels: {}, mounts: [], env: {}, parsed: { flags: {}, booleans: new Set() }, started: true, source: "" });
      }
    });
    expect(await exists(join(h.baseDir, stale))).toBe(false);
    expect(h.fake.containers.has(`jarvis-job-${stale}`)).toBe(false);
    expect(h.fake.containers.has("annen-tjeneste")).toBe(true);
    expect(await exists(join(h.baseDir, "ikke-en-uuid"))).toBe(true);
    expect(await readFile(join(h.baseDir, "notes.txt"), "utf8")).toBe("ikke rør");
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.logLines.some((l) => l.includes("reconcile_done"))).toBe(true);
  });

  it("selv rester med modus 000 og symlenker ut av treet ryddes uten å røre ting utenfor", async () => {
    const stale = "22222222-2222-4222-8222-222222222222";
    let outside;
    const h = await harness({
      beforeStart: async ({ root, baseDir }) => {
        outside = join(root, "utenfor.txt");
        await writeFile(outside, "skal-overleve");
        const { symlink, chmod } = await import("node:fs/promises");
        await mkdir(join(baseDir, stale, "work", "dypt", "enda"), { recursive: true });
        await symlink(outside, join(baseDir, stale, "work", "lenke"));
        await symlink(root, join(baseDir, stale, "work", "rotlenke"));
        await chmod(join(baseDir, stale, "work", "dypt", "enda"), 0o000);
        await chmod(join(baseDir, stale, "work", "dypt"), 0o500);
      }
    });
    expect(await exists(join(h.baseDir, stale))).toBe(false);
    expect(await readFile(outside, "utf8")).toBe("skal-overleve");
  });
});

describe("G: oppstartssjekker og docker-feil (fail-closed)", () => {
  it("jobbnettverket MÅ være --internal: oppstart nektes ellers", async () => {
    const h = await harness({ autoStart: false, beforeStart: ({ fake }) => { fake.state.networkInternal = false; } });
    await expect(h.service.start()).rejects.toMatchObject({ code: "job_network_not_internal" });
  });

  it("nettverket omkonfigureres mens tjenesten kjører: neste jobb nektes (503), ingenting opprettes", async () => {
    const h = await harness();
    h.fake.state.networkInternal = false;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(503);
    expect(r.json.error).toBe("job_network_not_internal");
    expect(h.fake.calls.some((c) => c.args[0] === "create")).toBe(false);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("docker utilgjengelig ved oppstart: tjenesten starter ikke", async () => {
    const h = await harness({ autoStart: false, beforeStart: ({ fake }) => { fake.state.daemonDown = true; } });
    await expect(h.service.start()).rejects.toMatchObject({ code: "docker_unavailable" });
  });

  it("jobb-uid må være tjenestens uid (ellers kan ikke runneren rydde filene agenten skrev)", async () => {
    // vi kjører en annen tjenesteinstans med uid-sjekken PÅ (ingen skipUidCheck) og standard policy.user 10001:10001
    const { createRunnerService } = await import("../server.mjs");
    const h = await harness({ autoStart: false });
    const strict = await createRunnerService({ config: h.config, dockerExec: h.fake.exec, testOverrides: { allowAnyOwner: true } });
    if (process.getuid?.() === 10001) return; // ekstremt usannsynlig; da er sjekken trivielt oppfylt
    await expect(strict.start()).rejects.toMatchObject({ code: "container_user_must_equal_service_uid" });
  });

  it("kun uid må være lik tjenestens uid - gid kan avvike (eierskap, ikke gruppe, avgjør om runneren kan rydde)", async () => {
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    if (uid === undefined || gid === undefined || uid === 0) return; // root som jobbbruker avvises uansett av policyen; testen trenger en vanlig bruker
    const { createRunnerService } = await import("../server.mjs");
    const h = await harness({ autoStart: false, runner: { user: `${uid}:${gid + 7}` } });
    const strict = await createRunnerService({ config: h.config, dockerExec: h.fake.exec, testOverrides: { allowAnyOwner: true } });
    try {
      await strict.start(); // kaster hvis uid-sjekken (fortsatt) også krever lik gid
    } finally {
      await strict.stop().catch(() => undefined);
    }
    // og feil uid avvises fortsatt, uansett gid
    const wrong = await harness({ autoStart: false, runner: { user: `${uid + 1}:${gid}` } });
    const strictWrong = await createRunnerService({ config: wrong.config, dockerExec: wrong.fake.exec, testOverrides: { allowAnyOwner: true } });
    await expect(strictWrong.start()).rejects.toMatchObject({ code: "container_user_must_equal_service_uid" });
  });

  it("docker create feiler: 502, ingen rester (katalog og container fjernet), slot frigjort", async () => {
    const h = await harness();
    h.fake.state.failCreate = true;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("container_create_failed");
    expect((await readdir(h.baseDir)).filter((n) => n !== ".runner")).toEqual([]);
  });

  it("docker start feiler: containeren fjernes, katalogen fjernes", async () => {
    const h = await harness();
    h.fake.state.failStart = true;
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("container_start_failed");
    expect(h.fake.containers.size).toBe(0);
    expect((await readdir(h.baseDir)).filter((n) => n !== ".runner")).toEqual([]);
  });

  it("klone feiler (repo finnes ikke i remote): 502, ingen rester", async () => {
    const h = await harness({ slugs: ["owner/repo", "owner/missing"], remote: undefined });
    // `owner/missing` har credential-fil, men origin ble opprettet — slett det bare repoet for å simulere manglende remote
    const { rm } = await import("node:fs/promises");
    await rm(h.origins["owner/missing"].dir, { recursive: true, force: true });
    const r = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/missing" } });
    expect(r.status).toBe(502);
    expect(r.json.error).toBe("git_network_failed");
    expect(h.fake.containers.size).toBe(0);
    expect((await readdir(h.baseDir)).filter((n) => n !== ".runner")).toEqual([]);
  });
});

describe("H: ingen hemmeligheter i logg eller feilsvar", () => {
  it("runner-token, git-token og env-verdier forekommer aldri i loggen", async () => {
    const h = await harness();
    const secret = "sk-ant-api03-HEMMELIG-VERDI-xyz";
    const job = await h.createJob({ env: { ANTHROPIC_API_KEY: secret }, task_id: "task-9" });
    await h.exec(job.job_id, ["sh", "-c", "echo $ANTHROPIC_API_KEY"], { env: { EXTRA_VAR: "annen-verdi-77" } });
    await h.exec(job.job_id, ["false"]);
    await h.api({ method: "POST", path: `/v1/jobs/${job.job_id}/publish`, body: { branch: "jarvis/task-9" } }); // ingen endringer -> no_changes
    await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    await h.api({ path: "/v1/health", token: "feil-token-feil-token-feil-token-feil-token" });
    const all = h.logLines.join("\n");
    for (const s of [RUNNER_TOKEN, GIT_TOKEN, secret, "annen-verdi-77", "feil-token-feil-token"]) expect(all, s).not.toContain(s);
    expect(all).not.toMatch(/authorization|bearer/i);
    for (const line of h.logLines) expect(() => JSON.parse(line)).not.toThrow(); // strukturert JSON per linje
    expect(all).toContain("job_created");
    expect(all).toContain("job_removed");
  });
});

describe("I: avslutning", () => {
  it("stop() fjerner alle containere og kataloger og socketen", async () => {
    const h = await harness();
    const a = await h.createJob();
    await h.createJob();
    await h.service.stop();
    expect(h.fake.containers.size).toBe(0);
    expect(await exists(join(h.baseDir, a.job_id))).toBe(false);
    expect(await exists(h.socketPath)).toBe(false);
  });
});
