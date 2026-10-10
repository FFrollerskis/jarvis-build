import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerClient } from "../lib/docker.mjs";
import { CancelToken, RunnerError } from "../lib/errors.mjs";
import { MAX_JOB_SECRET_BYTES, MAX_JOB_SECRET_VALUES } from "../lib/jobs.mjs";
import { SecretRegistry } from "../lib/log.mjs";
import { createRunnerService } from "../server.mjs";
import { GIT_TOKEN, RUNNER_TOKEN, apiRequest, createHarness } from "./support/harness.mjs";
import { makeTempDir } from "./support/tmp.mjs";

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

  /**
   * Agentens skript (kjøres INNE I «containeren»): ting som hindrer vanlig opprydding på verten - et tre LENGRE enn PATH_MAX (4096 bytes) med relative stier (også med
   * flerbyte-tegn, der lengden i TEGN lurer en sjekk), filnavn som ikke er gyldig UTF-8 (kan ikke adresseres via en JavaScript-streng), kataloger uten tilgang.
   */
  const deepTree = (name) =>
    `const fs=require("fs");const n=${name};fs.mkdirSync("dypt");process.chdir("dypt");for(let i=0;i<30;i++){fs.mkdirSync(n);process.chdir(n)}fs.writeFileSync("blad.txt","x");fs.chmodSync(".",0o500)`;
  const HOSTILE_TREES = {
    "dypere enn PATH_MAX (ASCII)": deepTree('"d".repeat(200)'),
    "dypere enn PATH_MAX med 3-byte-tegn (kort i tegn, lang i bytes)": deepTree('"\u65e5".repeat(80)'),
    "filnavn som ikke er gyldig UTF-8, og en katalog uten tilgang": 'const fs=require("fs");fs.writeFileSync(Buffer.concat([Buffer.from(process.cwd()+"/"),Buffer.from([0xff,0xfe])]),"x");fs.mkdirSync(Buffer.from([0xc3,0x28]));fs.writeFileSync(Buffer.concat([Buffer.from([0xc3,0x28]),Buffer.from("/f")]),"y");fs.mkdirSync("last");fs.writeFileSync("last/f","z");fs.chmodSync("last",0)'
  };

  for (const [label, script] of Object.entries(HOSTILE_TREES)) {
    it(`agenten lager ${label} i /work: DELETE fjerner likevel jobben helt (deleted:true) og slotten frigjøres - ingen permanent cleanup_pending`, async () => {
      const h = await harness({ runner: { max_concurrent_jobs: 1 } });
      const job = await h.createJob();
      const made = await h.exec(job.job_id, ["node", "-e", script]);
      expect(made.status, made.text).toBe(200);
      expect(made.json.code, made.json.stderr).toBe(0);
      const del = await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
      expect(del.status, del.text).toBe(200);
      expect(del.json).toEqual({ deleted: true, state: "gone" });
      expect(await exists(join(h.baseDir, job.job_id))).toBe(false);
      expect(h.service.manager.activeJobs).toBe(0);
      expect(h.logLines.join("\n")).not.toContain("remove_failed");
      // plassen er faktisk fri igjen (maks 1 samtidig jobb)
      expect((await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo" } })).status).toBe(201);
    }, 60_000);
  }

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

  it("rester av fiendtlige trær (dypere enn PATH_MAX med 3-byte-tegn, ugyldige UTF-8-navn) fra en krasjet kjøring ryddes ved oppstart", async () => {
    const stale = "33333333-3333-4333-8333-333333333333";
    const hostile = (dir) => {
      const script = 'const fs=require("fs");const n="\u65e5".repeat(80);fs.mkdirSync("dypt");process.chdir("dypt");for(let i=0;i<30;i++){fs.mkdirSync(n);process.chdir(n)}fs.writeFileSync("blad.txt","x");' +
        'process.chdir(process.argv[1]);fs.writeFileSync(Buffer.concat([Buffer.from(process.argv[1]+"/"),Buffer.from([0xff,0xfe])]),"x")';
      const r = spawnSync(process.execPath, ["-e", script, dir], { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(r.stderr);
    };
    const h = await harness({
      beforeStart: async ({ baseDir }) => {
        await mkdir(join(baseDir, stale, "work"), { recursive: true });
        hostile(join(baseDir, stale, "work"));
      }
    });
    expect(await exists(join(h.baseDir, stale))).toBe(false);
    expect(h.logLines.join("\n")).not.toContain("remove_failed");
  }, 60_000);

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

describe("K: hemmelige env-verdier per jobb har tak og dedupes (A-F8)", () => {
  it("samme verdi sendt i hvert exec-kall vokser ikke: registeret og jobbens liste forblir på én verdi, og redigeringen virker hele tiden", async () => {
    const h = await harness();
    const job = await h.createJob();
    const before = h.registry.size;
    for (let i = 0; i < 200; i += 1) {
      const r = await h.exec(job.job_id, ["sh", "-c", "echo $CALL_VAR"], { env: { CALL_VAR: "samme-verdi-hver-gang-123" } });
      expect(r.json.stdout).toBe("[REDACTED]\n");
    }
    expect(h.registry.size).toBe(before + 1);
    expect(h.service.manager.jobs.get(job.job_id).secretValues).toHaveLength(1);
  }, 60_000);

  it(`over ${MAX_JOB_SECRET_VALUES} ULIKE verdier avvises (400 env_values_limit_exceeded) FØR noe registreres; jobben lever videre og tidligere verdier redigeres fortsatt`, async () => {
    const h = await harness();
    const job = await h.createJob();
    const before = h.registry.size;
    for (let i = 0; i < MAX_JOB_SECRET_VALUES; i += 1) {
      expect((await h.exec(job.job_id, ["true"], { env: { CALL_VAR: `verdi-${String(i).padStart(4, "0")}-xxxxxxxx` } })).status, String(i)).toBe(200);
    }
    expect(h.registry.size).toBe(before + MAX_JOB_SECRET_VALUES);
    const over = await h.exec(job.job_id, ["true"], { env: { CALL_VAR: "en-verdi-for-mye-xxxxxxxx" } });
    expect(over.status).toBe(400);
    expect(over.json.error).toBe("env_values_limit_exceeded");
    expect(h.registry.size).toBe(before + MAX_JOB_SECRET_VALUES); // den avviste verdien ble ikke registrert
    const ok = await h.exec(job.job_id, ["sh", "-c", "echo verdi-0007-xxxxxxxx"]);
    expect(ok.json.stdout).toBe("[REDACTED]\n"); // en tidligere verdi redigeres fortsatt
    await h.api({ method: "DELETE", path: `/v1/jobs/${job.job_id}` });
    expect(h.registry.size).toBe(before); // alt ryddes når jobben fjernes
  }, 60_000);

  it(`total størrelse over ${MAX_JOB_SECRET_BYTES / 1024} KiB avvises også (store verdier); jobben lever videre`, async () => {
    const h = await harness();
    const job = await h.createJob();
    const big = (n) => `${String(n).padStart(4, "0")}${"x".repeat(8188)}`; // 8192 tegn, unike
    const perValue = Buffer.byteLength(big(0));
    const allowed = Math.floor(MAX_JOB_SECRET_BYTES / perValue);
    for (let i = 0; i < allowed; i += 1) expect((await h.exec(job.job_id, ["true"], { env: { CALL_VAR: big(i) } })).status, String(i)).toBe(200);
    const over = await h.exec(job.job_id, ["true"], { env: { CALL_VAR: big(allowed) } });
    expect(over.json).toMatchObject({ error: "env_values_limit_exceeded" });
  }, 60_000);

  it("create med for store verdier (16 navn x 8192 tegn à 3 byte = 384 KiB) avvises 400 FØR noe opprettes eller registreres", async () => {
    const names = Array.from({ length: 16 }, (_, i) => `ENVNAME_${i}`);
    const h = await harness({ runner: { env_allow: names, max_body_bytes: 1024 * 1024 } }); // kroppstaket (256 KiB) ville ellers gitt 413 først
    const before = { jobs: h.service.manager.activeJobs, size: h.registry.size, dirs: (await readdir(h.baseDir)).length, calls: h.fake.calls.length };
    const env = Object.fromEntries(names.map((name, i) => [name, `${i}`.padStart(2, "0") + "€".repeat(8190)]));
    const created = await h.api({ method: "POST", path: "/v1/jobs", body: { repo: "owner/repo", env } });
    expect(created.status).toBe(400);
    expect(created.json.error).toBe("env_values_limit_exceeded");
    expect(h.service.manager.activeJobs).toBe(before.jobs);
    expect(h.registry.size).toBe(before.size);
    expect((await readdir(h.baseDir)).length).toBe(before.dirs);
    expect(h.fake.calls.slice(before.calls).some((c) => ["create", "start", "exec"].includes(c.args[0]))).toBe(false);
  });
});

describe("L: tokenrotasjon feiler lukket, og en nektet andre instans river ikke den første (A-F5, A-F6)", () => {
  const newToken = "B".repeat(48);
  const status = (h, token) => apiRequest(h.socketPath, { token, path: "/v1/health" }).then((r) => r.status);

  it("A-F5: en feilet rotasjon (ugyldig/for kort token, manglende fil, feil modus) ugyldiggjør det GAMLE tokenet også - alt gir 401 til en vellykket reload", async () => {
    const h = await harness();
    expect(await status(h, RUNNER_TOKEN)).toBe(200);
    const broken = [
      ["for kort", () => writeFile(h.tokenFile, "for-kort\n")],
      ["ugyldige tegn", () => writeFile(h.tokenFile, `${"æ".repeat(40)}\n`)],
      ["åpen modus", async () => { await writeFile(h.tokenFile, `${newToken}\n`); await chmod(h.tokenFile, 0o666); }]
    ];
    for (const [label, breakIt] of broken) {
      await writeFile(h.tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
      await chmod(h.tokenFile, 0o600);
      await h.service.reloadToken();                 // gyldig utgangspunkt
      expect(await status(h, RUNNER_TOKEN), label).toBe(200);
      await breakIt();
      await expect(h.service.reloadToken(), label).rejects.toThrow();
      expect(await status(h, RUNNER_TOKEN), `${label}: gammelt token`).toBe(401); // før: 200 - rotasjonen «feilet stille»
      expect(await status(h, newToken), `${label}: nytt token`).toBe(401);
    }
    // en manglende fil likeså
    await writeFile(h.tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
    await chmod(h.tokenFile, 0o600);
    await h.service.reloadToken();
    const { rm } = await import("node:fs/promises");
    await rm(h.tokenFile);
    await expect(h.service.reloadToken()).rejects.toThrow();
    expect(await status(h, RUNNER_TOKEN)).toBe(401);
    // gjenoppretting: en gyldig fil + ny reload -> det NYE tokenet virker, det gamle gjør det ikke
    await writeFile(h.tokenFile, `${newToken}\n`, { mode: 0o600 });
    await chmod(h.tokenFile, 0o600);
    await h.service.reloadToken();
    expect(await status(h, newToken)).toBe(200);
    expect(await status(h, RUNNER_TOKEN)).toBe(401);
    const log = h.logLines.join("\n");
    expect(log).toContain("token_reload_failed_all_requests_denied");
    expect(log).toContain("token_reloaded");
    expect(log).not.toContain(newToken);
  });

  it("A-F6: en andre instans mot samme socket nektes (another_instance_is_listening) UTEN å rive første instans' jobber - avstemmingen kjører etter socket-sjekken", async () => {
    const h = await harness();
    const job = await h.createJob();
    expect(h.fake.containers.size).toBe(1);
    const second = await createRunnerService({
      config: h.config, dockerExec: h.fake.exec,
      testOverrides: { remote: { protocol: "https", host: "github.com" }, skipUidCheck: true, allowAnyOwner: true, authFailureDelayMs: 0 }
    });
    await expect(second.start()).rejects.toMatchObject({ code: "another_instance_is_listening" });
    // første instans' jobb lever: containeren, katalogen og API-et (før: reconcile() fjernet containeren og katalogen FØR socket-sjekken)
    expect(h.fake.containers.size).toBe(1);
    expect((await readdir(h.baseDir)).includes(job.job_id)).toBe(true);
    expect((await h.exec(job.job_id, ["echo", "lever"])).json.stdout).toBe("lever\n");
  });
});

describe("M: DockerClient.assertName (D1) - bare navn vi selv har laget kan nå docker", () => {
  it("start/exec/rm med et navn som ikke er jarvis-job-<uuid> kaster container_name_invalid UTEN at docker kalles (flagg-/argv-injeksjon via navn er umulig)", async () => {
    const calls = [];
    const docker = new DockerClient({ exec: async (args) => { calls.push(args); return { status: 0, signal: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false }; }, registry: new SecretRegistry() });
    const good = `jarvis-job-${"a".repeat(8)}-aaaa-4aaa-8aaa-${"b".repeat(12)}`;
    for (const bad of ["--privileged", "-v", "jarvis-job-x", "jarvis-job-", "jarvis-job-../../etc", `${good}; reboot`, ` ${good}`, `${good}\n`, "", "JARVIS-JOB-AAAAAAAA-AAAA-4AAA-8AAA-BBBBBBBBBBBB", "container:abc", "$(id)"]) {
      await expect(docker.start(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "container_name_invalid", status: 500 });
      await expect(docker.execIn(bad, { argv: ["true"], env: {}, timeoutMs: 1000, maxOutputBytes: 10 }), JSON.stringify(bad)).rejects.toMatchObject({ code: "container_name_invalid" });
      await expect(docker.remove(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "container_name_invalid" });
    }
    expect(calls).toEqual([]);
    await docker.start(good);
    await docker.remove(good);
    expect(calls.map((c) => c[0])).toEqual(["start", "rm"]);
  });

  it("A-F2 (docker): en avkortet `docker ps` regnes ikke som en komplett liste - oppstartsavstemmingen feiler lukket i stedet for å overse containere", async () => {
    const docker = new DockerClient({ exec: async () => ({ status: 0, signal: null, stdout: Buffer.from("jarvis-job-a\n"), stderr: Buffer.alloc(0), timedOut: false, truncated: true, cancelled: false }), registry: new SecretRegistry() });
    await expect(docker.listJobContainers()).rejects.toMatchObject({ code: "docker_output_truncated", status: 503 });
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

describe("J: socket-katalogen er persistent og trygg (bind-mount i worker peker på selve katalog-inoden)", () => {
  const health = (socketPath) => apiRequest(socketPath, { token: RUNNER_TOKEN, path: "/v1/health" });

  it("en manglende socket-katalog opprettes med modus 0750 (selv om prosessen har umask 0077), og socketen er 0660", async () => {
    const base = await makeTempDir("jr-sock-");
    const socketPath = join(base, "state", "sock", "runner.sock");
    const previous = process.umask(0o077); // som UMask=0077 i systemd-enheten
    let h;
    try {
      h = await harness({ runner: { socket_path: socketPath } });
    } finally {
      process.umask(previous);
    }
    expect((await stat(join(base, "state", "sock"))).mode & 0o777).toBe(0o750);
    expect((await stat(socketPath)).mode & 0o777).toBe(0o660);
    expect((await health(socketPath)).status).toBe(200);
    void h;
  });

  it("stop og ny start beholder SAMME katalog-inode (en gammel bind-mount forblir gyldig), og den nye socketen virker i samme katalog", async () => {
    const base = await makeTempDir("jr-sock-");
    const socketPath = join(base, "sock", "runner.sock");
    const first = await harness({ runner: { socket_path: socketPath } });
    const before = await stat(join(base, "sock"));
    await first.service.stop();
    expect(await exists(socketPath)).toBe(false);          // socket-filen fjernes ved stopp...
    expect((await stat(join(base, "sock"))).ino).toBe(before.ino); // ...men katalogen blir stående
    const second = await harness({ runner: { socket_path: socketPath } });
    const after = await stat(join(base, "sock"));
    expect({ ino: after.ino, dev: after.dev }).toEqual({ ino: before.ino, dev: before.dev });
    expect((await health(socketPath)).status).toBe(200);
    void second;
  });

  it("en eksisterende katalog som er skrivbar for gruppe/andre nektes (en annen bruker kunne byttet ut socketen)", async () => {
    for (const mode of [0o770, 0o775, 0o777, 0o722]) {
      const base = await makeTempDir("jr-sock-");
      await mkdir(join(base, "sock"));
      await chmod(join(base, "sock"), mode);
      const h = await harness({ autoStart: false, runner: { socket_path: join(base, "sock", "runner.sock") } });
      await expect(h.service.start(), mode.toString(8)).rejects.toMatchObject({ code: "socket_dir_writable_by_group_or_others" });
      expect(await exists(join(base, "sock", "runner.sock"))).toBe(false);
    }
  });

  it("socket-katalogen kan ikke være en symlenke (til en katalog agenten/andre kontrollerer)", async () => {
    const base = await makeTempDir("jr-sock-");
    await mkdir(join(base, "annen"));
    await symlink(join(base, "annen"), join(base, "sock"));
    const h = await harness({ autoStart: false, runner: { socket_path: join(base, "sock", "runner.sock") } });
    await expect(h.service.start()).rejects.toMatchObject({ code: "socket_dir_not_a_plain_directory" });
    expect(await exists(join(base, "annen", "runner.sock"))).toBe(false);
  });

  it("en eksisterende 0750-katalog (laget av install-host.sh) beholdes uendret", async () => {
    const base = await makeTempDir("jr-sock-");
    await mkdir(join(base, "sock"));
    await chmod(join(base, "sock"), 0o750);
    const before = await stat(join(base, "sock"));
    const h = await harness({ runner: { socket_path: join(base, "sock", "runner.sock") } });
    const after = await stat(join(base, "sock"));
    expect({ ino: after.ino, mode: after.mode & 0o777 }).toEqual({ ino: before.ino, mode: 0o750 });
    void h;
  });
});
