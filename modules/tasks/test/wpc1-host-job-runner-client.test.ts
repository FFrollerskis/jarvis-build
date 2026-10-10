import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitPolicyError, HostJobRunnerConfigError, HostJobRunnerError, HostJobSandboxRunner, FailClosedSandboxRunner, resolveJobSandboxRunner } from "@jarvis/tasks";
// @ts-expect-error - .mjs uten typer (ops/job-runner; samme mønster som ops/security i andre tester)
import { RUNNER_TOKEN, createHarness, gitSync } from "../../../ops/job-runner/test/support/harness.mjs";
import { makeTempDir } from "../../../ops/job-runner/test/support/tmp.mjs";

/**
 * WP-C1: worker-klienten (`HostJobSandboxRunner`) mot den EKTE vertstjenesten over et temp-Unix-socket (fake docker + ekte git mot
 * lokalt bare-repo). Beviser protokollen ende-til-ende og at klienten feiler lukket ved enhver feilkonfigurasjon/-tilstand.
 */

type Harness = Awaited<ReturnType<typeof createHarness>>;
const harnesses: Harness[] = [];
const harness = async (options?: unknown): Promise<Harness> => {
  const h = (await createHarness(options)) as Harness;
  harnesses.push(h);
  return h;
};
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});
const runnerFor = (h: Harness, overrides: Record<string, unknown> = {}) => new HostJobSandboxRunner({ socketPath: h.socketPath, tokenFile: h.tokenFile, ...overrides });
const REPO = "https://github.com/owner/repo.git";

describe("A: full syklus (create -> gitCheckout -> exec -> gitPublish -> dispose)", () => {
  it("kjører en jobb gjennom ekte vertstjeneste og pusher jobb-branchen", async () => {
    const h = await harness();
    const runner = runnerFor(h);
    expect(runner.hostGit).toBe(true);
    expect(runner.name).toBe("host-job-runner");
    const sandbox = await runner.create({ ANTHROPIC_API_KEY: "sk-ant-api03-test-hemmelig" }, { task_id: "task-1", tenant_id: "tenant-a" });
    expect(sandbox.workdir).toBe("/work");
    const checkout = await sandbox.gitCheckout!({ repoUrl: REPO });
    expect(checkout.baseBranch).toBe("main");
    expect(checkout.headSha).toBe(h.origins["owner/repo"].head);
    const r = await sandbox.exec("sh", ["-c", "echo hei > ny.txt && git checkout -q -b jarvis/task-1 && git add -A && git commit -q -m agent && git rev-parse HEAD"]);
    expect(r.code).toBe(0);
    const published = await sandbox.gitPublish!({ branch: "jarvis/task-1" });
    expect(published).toMatchObject({ branch: "jarvis/task-1", commitSha: r.stdout.trim(), baseSha: checkout.headSha, commits: 1, filesChanged: 1 });
    expect(gitSync(h.origins["owner/repo"].dir, ["rev-parse", "jarvis/task-1"])).toBe(published.commitSha);
    // sporbarhet: task-id er merket på containeren
    expect([...h.fake.containers.values()][0].labels["jarvis.task_id"]).toBe("task-1");
    await sandbox.dispose();
    expect(h.fake.containers.size).toBe(0);
    await sandbox.dispose(); // idempotent
  });

  it("exec videresender argv uten shell, per-kall env, og tidsavbrudd gir kode 124 + dødt sandbox-stempel", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    const args = ["--privileged", "$(id)", "a b", ";rm -rf /"];
    const echoed = await sandbox.exec("echo", args, 10_000, { CALL_VAR: "v" });
    expect(echoed).toEqual({ code: 0, stdout: "--privileged $(id) a b ;rm -rf /\n", stderr: "" });
    const hung = await sandbox.exec("sleep", ["30"], 1_000);
    expect(hung.code).toBe(124);
    expect(await sandbox.exec("true", [])).toEqual({ code: 1, stdout: "", stderr: "job_container_terminated" });
    await sandbox.dispose();
    expect(h.service.manager.activeJobs).toBe(0);
  }, 30_000);

  it("exec før gitCheckout og dobbel gitCheckout kaster; ingen jobb opprettes av create() alene", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    expect(h.service.manager.activeJobs).toBe(0);
    await expect(Promise.resolve(sandbox.exec("true", []))).rejects.toThrow("host_job_not_checked_out");
    await expect(sandbox.gitPublish!({ branch: "jarvis/x" })).rejects.toThrow("host_job_not_checked_out");
    await sandbox.gitCheckout!({ repoUrl: REPO });
    await expect(sandbox.gitCheckout!({ repoUrl: REPO })).rejects.toThrow("host_job_already_checked_out");
    await sandbox.dispose();
  });

  it("jobben utløpt/fjernet hos runneren: exec gir kode 1 job_expired (aldri hengende)", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    const id = [...h.service.manager.jobs.keys()][0] as string;
    await h.api({ method: "DELETE", path: `/v1/jobs/${id}` });
    expect(await sandbox.exec("true", [])).toEqual({ code: 1, stdout: "", stderr: "job_expired" });
    await sandbox.dispose();
  });
});

describe("B: klienten feiler lukket", () => {
  it("repo som ikke er på runnerens allowlist: HostJobRunnerError(repo_not_allowed, 403) - ingenting opprettes", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    const err = await sandbox.gitCheckout!({ repoUrl: "https://github.com/owner/annet.git" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "repo_not_allowed", status: 403 });
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("repo-URL som ikke er eksakt https://github.com/<owner>/<repo>: GitPolicyError FØR noe sendes", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    for (const repoUrl of ["https://evil.example/owner/repo", "file:///etc", "git@github.com:owner/repo", "--upload-pack=x", "https://github.com/owner/repo/extra", "https://user@github.com/owner/repo"]) {
      await expect(sandbox.gitCheckout!({ repoUrl }), repoUrl).rejects.toBeInstanceOf(GitPolicyError);
    }
    expect(h.fake.calls.some((c: { args: string[] }) => c.args[0] === "create")).toBe(false);
  });

  it("forbudte env-navn (git-credential, vault, proxy, HOME) avvises i create() og i exec uten at noe sendes til runneren", async () => {
    const h = await harness();
    const runner = runnerFor(h);
    for (const name of ["JARVIS_GIT_CREDENTIAL_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "INFISICAL_CLIENT_SECRET", "HTTPS_PROXY", "HOME", "LD_PRELOAD"]) {
      await expect(runner.create({ [name]: "x" }), name).rejects.toThrow(`job_env_forbidden:${name}`);
    }
    const sandbox = await runner.create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    const denied = await sandbox.exec("env", [], 5_000, { JARVIS_GIT_CREDENTIAL_TOKEN: "x" });
    expect(denied).toEqual({ code: 1, stdout: "", stderr: "job_env_forbidden:JARVIS_GIT_CREDENTIAL_TOKEN" });
    expect(h.fake.calls.filter((c: { args: string[] }) => c.args[0] === "exec")).toHaveLength(0);
    await sandbox.dispose();
  });

  it("feil token: HostJobRunnerError(unauthorized); meldingen inneholder aldri tokenet", async () => {
    const h = await harness();
    const dir = await makeTempDir("jr-badtok-");
    const badFile = join(dir, "token");
    await writeFile(badFile, "feil-token-feil-token-feil-token-feil-token\n", { mode: 0o600 });
    const sandbox = await runnerFor(h, { tokenFile: badFile }).create();
    const err = await sandbox.gitCheckout!({ repoUrl: REPO }).catch((e: unknown) => e) as Error;
    expect(err).toMatchObject({ code: "unauthorized", status: 401 });
    expect(err.message).not.toContain("feil-token");
    expect(err.message).not.toContain(RUNNER_TOKEN);
  });

  it("manglende/ugyldig tokenfil: token_unavailable / token_invalid", async () => {
    const h = await harness();
    const dir = await makeTempDir("jr-notok-");
    const missing = await runnerFor(h, { tokenFile: join(dir, "finnes-ikke") }).create();
    await expect(missing.gitCheckout!({ repoUrl: REPO })).rejects.toMatchObject({ code: "token_unavailable" });
    const shortFile = join(dir, "kort");
    await writeFile(shortFile, "for-kort\n", { mode: 0o600 });
    const short = await runnerFor(h, { tokenFile: shortFile }).create();
    await expect(short.gitCheckout!({ repoUrl: REPO })).rejects.toMatchObject({ code: "token_invalid" });
    const spaced = join(dir, "mellomrom");
    await writeFile(spaced, `${RUNNER_TOKEN} med mellomrom\n`, { mode: 0o600 });
    await expect((await runnerFor(h, { tokenFile: spaced }).create()).gitCheckout!({ repoUrl: REPO })).rejects.toMatchObject({ code: "token_invalid" });
    await chmod(spaced, 0o600);
  });

  it("runner nede (socket finnes ikke / ingen lytter): unreachable med feilkode, ingen hengende forespørsel", async () => {
    const dir = await makeTempDir("jr-down-");
    const tokenFile = join(dir, "token");
    await writeFile(tokenFile, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
    const runner = new HostJobSandboxRunner({ socketPath: join(dir, "ingen.sock"), tokenFile });
    const sandbox = await runner.create();
    const err = await sandbox.gitCheckout!({ repoUrl: REPO }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "unreachable" });
    expect((err as Error).message).toMatch(/host_job_runner_error:unreachable:ENOENT/);
    await sandbox.dispose(); // best effort - kaster ikke
  });

  it("token roteres uten omstart av worker: ny fil + SIGHUP-ekvivalent hos runneren; gammelt token slutter å virke", async () => {
    const h = await harness();
    const sandbox = await runnerFor(h).create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    const fresh = "rotert-token-0123456789abcdefABCDEF-xyz";
    await writeFile(h.tokenFile, `${fresh}\n`, { mode: 0o600 });
    await h.service.reloadToken();
    // klienten leser fila på nytt for hver forespørsel -> fortsetter å virke
    expect((await sandbox.exec("echo", ["ok"])).stdout).toBe("ok\n");
    const stale = await runnerFor(h, { readToken: async () => RUNNER_TOKEN }).create();
    await expect(stale.gitCheckout!({ repoUrl: REPO })).rejects.toMatchObject({ code: "unauthorized" });
    await sandbox.dispose();
  });
});

describe("C: konfigurasjon og resolveJobSandboxRunner (fail-closed)", () => {
  const valid = { JARVIS_JOB_RUNNER: "host", JARVIS_JOB_RUNNER_SOCKET: "/run/jarvis-job-runner/runner.sock", JARVIS_JOB_RUNNER_TOKEN_FILE: "/run/secrets/jarvis-job-runner-token" };

  it("gyldig host-konfig gir HostJobSandboxRunner med hostGit", () => {
    const runner = resolveJobSandboxRunner(valid);
    expect(runner).toBeInstanceOf(HostJobSandboxRunner);
    expect(runner.hostGit).toBe(true);
  });

  it("enhver feilkonfigurasjon gir FailClosedSandboxRunner (jobben feiler med job_container_runner_not_configured:<grunn>) - aldri prosess-sandbox", async () => {
    const cases: Array<Record<string, string>> = [
      {}, { JARVIS_JOB_RUNNER: "process" }, { JARVIS_JOB_RUNNER: "HOST" }, { JARVIS_JOB_RUNNER: "host " }, { JARVIS_SANDBOX: "process" }, { JARVIS_SANDBOX: "docker" },
      { ...valid, JARVIS_JOB_RUNNER_SOCKET: "" }, { ...valid, JARVIS_JOB_RUNNER_SOCKET: "relative.sock" }, { ...valid, JARVIS_JOB_RUNNER_SOCKET: "/run/../etc/x.sock" },
      { ...valid, JARVIS_JOB_RUNNER_SOCKET: "/run/a b/x.sock" }, { ...valid, JARVIS_JOB_RUNNER_SOCKET: "/run/x.sock;rm" }, { ...valid, JARVIS_JOB_RUNNER_SOCKET: `/${"a".repeat(120)}` },
      { ...valid, JARVIS_JOB_RUNNER_TOKEN_FILE: "" }, { ...valid, JARVIS_JOB_RUNNER_TOKEN_FILE: "token" }, { ...valid, JARVIS_JOB_RUNNER_TOKEN_FILE: "/run/../etc/passwd" },
      { JARVIS_JOB_RUNNER_SOCKET: valid.JARVIS_JOB_RUNNER_SOCKET, JARVIS_JOB_RUNNER_TOKEN_FILE: valid.JARVIS_JOB_RUNNER_TOKEN_FILE }
    ];
    for (const env of cases) {
      const runner = resolveJobSandboxRunner(env);
      expect(runner, JSON.stringify(env)).toBeInstanceOf(FailClosedSandboxRunner);
      await expect(runner.create(), JSON.stringify(env)).rejects.toThrow(/^job_container_runner_not_configured:/);
    }
  });

  it("host-modus ignorerer image/nettverk/proxy fra worker-env (de bestemmes av vertsadmins konfigfil)", () => {
    const runner = resolveJobSandboxRunner({ ...valid, JARVIS_JOB_IMAGE: "evil:latest", JARVIS_JOB_NETWORK: "host", JARVIS_JOB_EGRESS_PROXY: "http://evil:1" });
    expect(runner).toBeInstanceOf(HostJobSandboxRunner);
  });

  it("konstruktør validerer stier direkte", () => {
    expect(() => new HostJobSandboxRunner({ socketPath: "relativ", tokenFile: "/x" })).toThrow(HostJobRunnerConfigError);
    expect(() => new HostJobSandboxRunner({ socketPath: "/run/x.sock", tokenFile: "relativ" })).toThrow(HostJobRunnerConfigError);
  });

  it("eksisterende container-modus er uendret (gyldig konfig gir DockerJobSandboxRunner)", () => {
    const image = `node:22-bookworm-slim@sha256:${"a".repeat(64)}`;
    expect(resolveJobSandboxRunner({ JARVIS_JOB_RUNNER: "container", JARVIS_JOB_IMAGE: image, JARVIS_JOB_NETWORK: "jarvis-jobs", JARVIS_JOB_EGRESS_PROXY: "http://job-egress:3128" }).name).toBe("docker-job-container");
  });
});
