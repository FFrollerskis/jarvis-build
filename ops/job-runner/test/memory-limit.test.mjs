import { afterEach, describe, expect, it } from "vitest";
import { HostGit } from "../lib/git.mjs";
import { SecretRegistry } from "../lib/log.mjs";
import { deltaBombBundle } from "./support/delta-bomb.mjs";
import { createGitSpy } from "./support/git-spy.mjs";
import { createHarness, gitSync } from "./support/harness.mjs";

/**
 * WP-C1 review A-F3: agenten velger innholdet i pakken vertens git parser. En delta-bombe (16 kB -> 1,5 GiB) tok i en måling all ledig vertsminne (publish 54 s). Forsvaret her er den
 * delen som lar seg bevise uten systemd: `prlimit --as=<byte>` rundt HVERT git-kall som leser agentens objekter. `MemoryMax=`/`OOMPolicy=` i systemd-enheten er `NOT VERIFIED` (kun
 * enhetsfilen er testet, i infra.test.mjs); effekten av cgroup-taket måles på verten (acceptance.sh J06).
 */

/** @type {Array<{ close(): Promise<void> }>} */
let open = [];
afterEach(async () => {
  for (const h of open) await h.close().catch(() => undefined);
  open = [];
});
const harness = async (options) => { const h = await createHarness(options); open.push(h); return h; };
const publish = (h, id, branch = "jarvis/task-1") => h.api({ method: "POST", path: `/v1/jobs/${id}/publish`, body: { branch } });
const MIB = 1024 * 1024;

describe("A: wrapperen - argv og hvilke git-kall som begrenses", () => {
  const stub = (calls) => async (bin, args) => { calls.push({ bin, args }); return { status: 0, signal: null, stdout: Buffer.from("git version 2.43.0\n"), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false }; };
  const gitWith = (run, memoryLimit) => new HostGit({
    gitBin: "/usr/bin/git", nodePath: process.execPath, helperScript: "/x/helper.mjs", homeDir: "/tmp", templateDir: "/tmp",
    remote: { protocol: "https", host: "github.com" }, registry: new SecretRegistry(), run, ...(memoryLimit ? { memoryLimit } : {})
  });

  it("limited: prlimit --as=<byte> -- git -c pack.threads=1 <args>; uten limited kjøres git direkte", async () => {
    const calls = [];
    const git = gitWith(stub(calls), { prlimitBin: "/usr/bin/prlimit", bytes: 512 * MIB });
    await git.git(["fsck", "--strict"], { limited: true });
    await git.git(["init", "--bare", "x"], {});
    expect(calls[0]).toEqual({ bin: "/usr/bin/prlimit", args: ["--as=536870912", "--", "/usr/bin/git", "-c", "pack.threads=1", "fsck", "--strict"] });
    expect(calls[1]).toEqual({ bin: "/usr/bin/git", args: ["init", "--bare", "x"] });
  });

  it("limited uten konfigurert grense feiler lukket (aldri et stille ubegrenset kall); assertMemoryLimit likeså", async () => {
    const calls = [];
    const git = gitWith(stub(calls));
    await expect(git.git(["fsck"], { limited: true })).rejects.toMatchObject({ code: "git_memory_limit_not_configured" });
    await expect(git.assertMemoryLimit()).rejects.toMatchObject({ code: "git_memory_limit_not_configured" });
    expect(calls).toEqual([]);
  });

  it("assertMemoryLimit: kjører «git --version» under grensen og feiler lukket hvis prlimit ikke starter, avviser, eller git ikke svarer", async () => {
    const limit = { prlimitBin: "/usr/bin/prlimit", bytes: 256 * MIB };
    const base = { status: 0, signal: null, stdout: Buffer.from("git version 2.43.0\n"), stderr: Buffer.alloc(0), timedOut: false, truncated: false, cancelled: false };
    const run = (result) => async () => ({ ...base, ...result });
    await expect(gitWith(run({}), limit).assertMemoryLimit()).resolves.toBeUndefined();
    await expect(gitWith(run({ spawnError: "ENOENT" }), limit).assertMemoryLimit()).rejects.toMatchObject({ code: "git_memory_limit_unusable", detail: "prlimit_could_not_start" });
    await expect(gitWith(run({ status: 1, stderr: Buffer.from("prlimit: failed to set the AS resource limit") }), limit).assertMemoryLimit()).rejects.toMatchObject({ code: "git_memory_limit_unusable" });
    await expect(gitWith(run({ stdout: Buffer.from("noe helt annet") }), limit).assertMemoryLimit()).rejects.toMatchObject({ code: "git_memory_limit_unusable" });
  });

  it("ende-til-ende (git-spy måler RLIMIT_AS i selve git-prosessen): publish begrenser fetch av bundle, fsck, rev-parse, merge-base, rev-list og diff-tree - men ikke nettverkskallene (base-fetch, ls-remote, push), init eller klone", async () => {
    const spy = await createGitSpy();
    const h = await harness({ runner: { git_bin: spy.gitBin, git_memory_limit_mb: 768 } });
    const job = await h.createJob();
    await h.exec(job.job_id, ["sh", "-c", "echo hei > nytt.txt && git add -A && git commit -q -m agent"]);
    expect((await publish(h, job.job_id)).status).toBe(200);
    const calls = await spy.calls();
    const limit = String(768 * MIB);
    const bySub = (sub) => calls.filter((c) => c.subcommand === sub);
    // parser agentens data: ALLE under grensen
    const limited = [
      ...bySub("fsck"), ...bySub("diff-tree"), ...bySub("merge-base"), ...bySub("rev-list"),
      ...calls.filter((c) => c.subcommand === "fetch" && c.argv.some((a) => a.endsWith("out.bundle"))),
      ...calls.filter((c) => c.subcommand === "rev-parse" && c.argv.includes("refs/jarvis/candidate^{commit}"))
    ];
    expect(limited.length).toBeGreaterThanOrEqual(7);
    for (const c of limited) {
      expect(c.addressSpace, c.argv.join(" ")).toBe(limit);
      expect(c.argv).toContain("pack.threads=1");
    }
    // oppstartskontrollen kjører også under grensen
    expect(calls.some((c) => c.argv.includes("--version") && c.addressSpace === limit)).toBe(true);
    // og nettverkskallene (base-henting fra GitHub, ls-remote, push: credential-helperen er Node og trenger ca. 750 MiB adresserom), initialisering og lokal klone av runnerens egen
    // base.git er IKKE begrenset (legitime store repoer må kunne klones, og push kjører først etter fsck --strict har lest hvert objekt under grensen)
    const unlimited = [...bySub("init"), ...bySub("clone"), ...bySub("ls-remote"), ...bySub("push"), ...calls.filter((c) => c.subcommand === "fetch" && !c.argv.some((a) => a.endsWith("out.bundle")))];
    expect(unlimited.length).toBeGreaterThanOrEqual(4);
    for (const c of unlimited) expect(c.addressSpace, c.argv.join(" ")).toBe("unlimited");
  }, 60_000);
});

describe("B: delta-bombe mot den ekte vertstjenesten (ekte git og ekte prlimit, fake docker)", () => {
  /** Leverer en bombe (`copies` x 16 MiB) som svar på `git bundle create` i containeren, og publiserer. */
  async function publishBomb(h, copies) {
    const job = await h.createJob();
    const { bundle, resultSize } = deltaBombBundle(copies, job.head_sha);
    expect(bundle.length).toBeLessThan(20_000); // en 16 kB pakke ...
    expect(resultSize).toBeGreaterThan(copies * 15 * MIB); // ... som ekspanderer til copies x 16 MiB
    h.fake.state.onExec = ({ argv }) => (argv.includes("bundle") && argv.includes("create") ? { status: 0, stdout: bundle, stderr: Buffer.alloc(0) } : undefined);
    return publish(h, job.job_id, "jarvis/bomb");
  }
  const noBranch = (h) => expect(gitSync(h.origins["owner/repo"].dir, ["for-each-ref", "--format=%(refname)"])).not.toContain("jarvis/");

  it("reviewerens størrelse (95 x 16 MiB = 1,5 GiB) med STANDARDGRENSEN (1024 MiB): git feiler rent med «Out of memory» FØR noe allokeres - sekunder, ikke 54 s og 1,6 GB; ingenting pushes", async () => {
    const h = await harness();
    expect(h.config.gitMemoryLimitMb).toBe(1024);
    const started = Date.now();
    const pub = await publishBomb(h, 95);
    expect(pub.status).toBe(422);
    expect(pub.json).toMatchObject({ error: "bundle_fetch_failed" });
    expect(pub.json.detail).toMatch(/out of memory/i);
    expect(Date.now() - started).toBeLessThan(15_000);
    noBranch(h);
  }, 60_000);

  it("terskel: samme 400 MiB-bombe (25 x 16 MiB) stoppes av en grense på 384 MiB, men slipper gjennom ekspansjonen med 1024 MiB - så det er GRENSEN som stopper den", async () => {
    const small = await harness({ runner: { git_memory_limit_mb: 384 } });
    const stopped = await publishBomb(small, 25);
    expect(stopped.json).toMatchObject({ error: "bundle_fetch_failed" });
    expect(stopped.json.detail).toMatch(/out of memory/i);
    noBranch(small);

    // kontroll: index-pack klarer ekspansjonen (ca. 420 MiB) under 1024 MiB. Publish feiler likevel lukket senere: bomben er ingen gyldig bundle (HEAD-commiten finnes ikke).
    const roomy = await harness({ runner: { git_memory_limit_mb: 1024 } });
    const passed = await publishBomb(roomy, 25);
    expect(passed.status).toBe(422);
    expect(passed.json.error).toMatch(/^bundle_/);
    expect(passed.json.detail ?? "").not.toMatch(/out of memory/i);
    noBranch(roomy);
  }, 90_000);
});

describe("C: oppstart feiler lukket hvis minnegrensen ikke kan håndheves", () => {
  it("prlimit finnes ikke / feiler: tjenesten nekter å starte med git_memory_limit_unusable (ingen jobb kan tas imot uten grensen)", async () => {
    for (const prlimit_bin of ["/nonexistent/prlimit", "/bin/false"]) {
      const h = await harness({ autoStart: false, runner: { prlimit_bin } });
      await expect(h.service.start(), prlimit_bin).rejects.toMatchObject({ code: "git_memory_limit_unusable" });
    }
  });
});
