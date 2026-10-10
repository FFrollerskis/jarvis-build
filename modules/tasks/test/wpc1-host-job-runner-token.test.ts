import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  FailClosedSandboxRunner, HostJobRunnerConfigError, HostJobRunnerError, HostJobSandboxRunner, ScriptedCodingAgent, createCodingHandler, resolveJobSandboxRunner,
  type ArtifactStore, type ClaimedTask, type HostGitCredentialSource, type JobContext, type PrPublishingGateway
} from "@jarvis/tasks";
// @ts-expect-error - .mjs uten typer (ops/job-runner; samme mønster som wpc1-host-job-runner-client.test.ts)
import { RUNNER_TOKEN, createHarness, gitSync, syntheticInstallationToken } from "../../../ops/job-runner/test/support/harness.mjs";
// @ts-expect-error - .mjs uten typer (git smart-HTTP-server som egen barneprosess; logger token-fingeravtrykk per operasjon)
import { fingerprint, startTokenGitServer } from "../../../ops/job-runner/test/support/token-git-server.mjs";
import { makeTempDir } from "../../../ops/job-runner/test/support/tmp.mjs";

/**
 * WP-C1 + WP-C3: worker-klienten sender et KORTLEVD, REPO-SCOPET git-token i jobbforespørselen (`git_token`) når den er gitt en `gitCredentialSource`
 * OG vertsadmin har satt repoet til `source: request`. Her testes klientsiden mot den EKTE vertstjenesten (Unix-socket, fake docker, ekte git mot en
 * autentiserende smart-HTTP-server): fersk token per operasjon, fail-closed ved enhver kildefeil, og at tokenet aldri lekker i feil, env eller forespørsler
 * det ikke hører hjemme i.
 */

type Harness = Awaited<ReturnType<typeof createHarness>>;
interface GitServer {
  host: string; reposRoot: string; createBareRepo(name: string): string; stop(): void;
  events: Array<{ ev: string; repo: string; op: string; h: string | null; withAuth?: boolean }>;
}
const harnesses: Harness[] = [];
const servers: GitServer[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
  for (const s of servers.splice(0)) s.stop();
  for (const c of cleanups.splice(0)) await c();
});
const harness = async (options?: unknown): Promise<Harness> => {
  const h = (await createHarness(options)) as Harness;
  harnesses.push(h);
  return h;
};
const gitServer = async (accepted: Array<{ pass: string; repo?: string }>, reflect?: "fetch" | "push"): Promise<GitServer> => {
  const s = (await startTokenGitServer({ accepted, ...(reflect ? { reflect } : {}) })) as GitServer;
  servers.push(s);
  return s;
};
const wait = async (cond: () => boolean, ms = 5000): Promise<boolean> => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
};

const REPO = "https://github.com/owner/repo.git";
const T1 = syntheticInstallationToken(300, 21) as string;
const T2 = syntheticInstallationToken(300, 22) as string;
const requestRepo = { requestTokenSlugs: ["owner/repo"] };
const runnerFor = (h: Harness, source?: HostGitCredentialSource, extra: Record<string, unknown> = {}) =>
  new HostJobSandboxRunner({ socketPath: h.socketPath, tokenFile: h.tokenFile, ...(source ? { gitCredentialSource: source } : {}), ...extra });
/** Kilde som husker kallene sine og gir et NYTT token hver gang. */
function rotatingSource(tokens: string[] = [T1, T2]) {
  const calls: string[] = [];
  const source: HostGitCredentialSource = { async tokenFor(slug) { calls.push(slug); return tokens[Math.min(calls.length, tokens.length) - 1] as string; } };
  return { calls, source };
}
const commitCmd = (branch: string): [string, string[]] => ["sh", ["-c", `echo hei > ny.txt && git checkout -q -b ${branch} && git add -A && git commit -q -m agent`]];
const caught = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);
/** create() + gitCheckout() i ett (feil fra begge faller ut som avvist løfte). */
const checkoutWith = async (runner: HostJobSandboxRunner, jobEnv: Record<string, string> = {}) => {
  const sandbox = await runner.create(jobEnv);
  return sandbox.gitCheckout!({ repoUrl: REPO });
};

describe("A: ferskt token per operasjon (klone og publish), bearer-autentisert over socketen", () => {
  it("klone = token 1, publish = token 2 (ikke gjenbrukt): serveren ser nøyaktig det fingeravtrykket for hver operasjon; kilden kalles med repo-sluggen", async () => {
    const server = await gitServer([{ pass: T1 }, { pass: T2 }]);
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...requestRepo, remote: { protocol: "http", host: server.host } });
    const { calls, source } = rotatingSource();
    const sandbox = await runnerFor(h, source).create({}, { task_id: "task-a1", tenant_id: "tenant-a" });
    expect(calls).toEqual([]); // create() alene henter ingenting
    await sandbox.gitCheckout!({ repoUrl: "https://github.com/Owner/Repo.git" }); // blandet case -> kanonisk slug
    expect(calls).toEqual(["owner/repo"]);
    const [cmd, args] = commitCmd("jarvis/task-a1");
    expect((await sandbox.exec(cmd, args)).code).toBe(0);
    expect(calls).toEqual(["owner/repo"]); // exec henter aldri et token
    const published = await sandbox.gitPublish!({ branch: "jarvis/task-a1" });
    expect(calls).toEqual(["owner/repo", "owner/repo"]);
    await wait(() => server.events.some((e) => e.op === "push"));
    expect(new Set(server.events.filter((e) => e.ev === "auth" && e.op === "fetch").map((e) => e.h))).toEqual(new Set([fingerprint(T1)]));
    expect(new Set(server.events.filter((e) => e.ev === "auth" && e.op === "push").map((e) => e.h))).toEqual(new Set([fingerprint(T2)]));
    expect(gitSync(`${server.reposRoot}/owner/repo.git`, ["rev-parse", "jarvis/task-a1"])).toBe(published.commitSha);
    // sporbarhet: task-id er merket på containeren, og loggen sier hvilken kilde som ble brukt (uten tokenet)
    expect([...h.fake.containers.values()][0].labels["jarvis.task_id"]).toBe("task-a1");
    expect(h.logLines.find((l: string) => l.includes('"job_created"'))).toContain('"git_auth":"request"');
    for (const t of [T1, T2]) {
      expect(h.logLines.join("\n")).not.toContain(t);
      for (const c of h.fake.calls as Array<{ args: string[]; env: Record<string, string> }>) {
        expect(c.args.join(" ")).not.toContain(t);
        expect(JSON.stringify(c.env)).not.toContain(t);
      }
      expect(spawnSync("grep", ["-rlaF", "--", t, h.root], { encoding: "utf8" }).stdout).toBe("");
    }
    await sandbox.dispose();
  }, 60_000);

  it("gjenbruker aldri et token mellom operasjoner: også en SECOND publish på samme jobb henter et nytt", async () => {
    const server = await gitServer([{ pass: T1 }, { pass: T2 }]);
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...requestRepo, remote: { protocol: "http", host: server.host } });
    const { calls, source } = rotatingSource([T1, T2, T1]);
    const sandbox = await runnerFor(h, source).create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    await sandbox.exec(...commitCmd("jarvis/task-a2"));
    await sandbox.gitPublish!({ branch: "jarvis/task-a2" });
    await sandbox.exec("sh", ["-c", "echo mer >> ny.txt && git add -A && git commit -q -m mer"]);
    await sandbox.gitPublish!({ branch: "jarvis/task-a2" });
    expect(calls).toHaveLength(3);
    await sandbox.dispose();
  }, 60_000);

  it("uten kilde sendes aldri noe token: et `request`-repo avviser (git_token_required), et `file`-repo fungerer som før", async () => {
    const h = await harness(requestRepo);
    const err = await caught(checkoutWith(runnerFor(h)));
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "git_token_required", status: 400 });
    expect(h.service.manager.activeJobs).toBe(0);
    const file = await harness();
    const sandbox = await runnerFor(file).create();
    expect((await sandbox.gitCheckout!({ repoUrl: REPO })).baseBranch).toBe("main");
    await sandbox.dispose();
  });

  it("med kilde mot et `file`-repo: runneren NEKTER tokenet (git_token_not_accepted) - jobben feiler lukket, tokenet er ikke i feilen", async () => {
    const h = await harness(); // standard = file
    const { source } = rotatingSource();
    const err = (await caught(checkoutWith(runnerFor(h, source)))) as Error;
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "git_token_not_accepted", status: 403 });
    expect(err.message).not.toContain(T1);
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
  });

  it("publish uten checkout: kilden kalles ikke, og ingenting sendes", async () => {
    const h = await harness(requestRepo);
    const { calls, source } = rotatingSource();
    const sandbox = await runnerFor(h, source).create();
    await expect(sandbox.gitPublish!({ branch: "jarvis/x" })).rejects.toThrow("host_job_not_checked_out");
    expect(calls).toEqual([]);
  });
});

describe("B: klienten feiler lukket ved enhver kildefeil - uten å gjengi kildens melding og uten at noe sendes til runneren", () => {
  const checkout = (h: Harness, source: HostGitCredentialSource, extra: Record<string, unknown> = {}, jobEnv: Record<string, string> = {}) =>
    checkoutWith(runnerFor(h, source, extra), jobEnv);

  it("kilden kaster en feil med hemmelighet i meldingen: git_credential_unavailable:source_failed - meldingen vises ikke", async () => {
    const h = await harness(requestRepo);
    const leak = syntheticInstallationToken(300, 31) as string;
    const err = (await caught(checkout(h, { tokenFor: async () => { throw new Error(`oppslag feilet for ${leak}`); } }))) as Error;
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "git_credential_unavailable", status: 0 });
    expect(err.message).toBe("host_job_runner_error:git_credential_unavailable:source_failed");
    expect(err.message).not.toContain(leak);
    expect(h.fake.calls.some((c: { args: string[] }) => c.args[0] === "create")).toBe(false);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("en stabil feilkode fra kilden (GITHUB_APP_SCOPE_MISMATCH e.l.) vises; en kode med fritekst/hemmelighet vises ikke", async () => {
    const h = await harness(requestRepo);
    const coded = (code: unknown) => ({ tokenFor: async () => { throw Object.assign(new Error("skjult melding"), { code }); } });
    const ok = (await caught(checkout(h, coded("GITHUB_APP_SCOPE_MISMATCH")))) as Error;
    expect(ok.message).toBe("host_job_runner_error:git_credential_unavailable:GITHUB_APP_SCOPE_MISMATCH");
    for (const bad of [`ghs_${"a".repeat(40)}`, "har mellomrom", "små_bokstaver", "A", "X".repeat(61), 123, null, { a: 1 }, "TOKEN\nHEI"]) {
      const err = (await caught(checkout(h, coded(bad)))) as Error;
      expect(err.message, String(bad)).toBe("host_job_runner_error:git_credential_unavailable:source_failed");
    }
  });

  it("en kilde som HENGER gir source_timeout etter credentialTimeoutMs; en kilde som feiler ETTER tidsgrensen gir ingen ubehandlet rejection", async () => {
    const h = await harness(requestRepo);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    cleanups.push(() => { process.off("unhandledRejection", listener); });
    const started = Date.now();
    const hang = (await caught(checkout(h, { tokenFor: () => new Promise<string>(() => undefined) }, { credentialTimeoutMs: 150 }))) as Error;
    expect(hang.message).toBe("host_job_runner_error:git_credential_unavailable:source_timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
    const late = (await caught(checkout(h, { tokenFor: () => new Promise<string>((_, reject) => setTimeout(() => reject(new Error("for sent")), 400)) }, { credentialTimeoutMs: 100 }))) as Error;
    expect(late.message).toBe("host_job_runner_error:git_credential_unavailable:source_timeout");
    await new Promise((r) => setTimeout(r, 700));
    expect(unhandled).toEqual([]);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("uvelformet svar fra kilden (ikke-streng, linjeskift-injeksjon, feil prefiks, for kort/lang, mellomrom) nektes FØR noe sendes", async () => {
    const h = await harness(requestRepo);
    const ok = `ghs_${"a".repeat(40)}`;
    const bad: unknown[] = [
      undefined, null, 12345678, {}, [], [ok], "", "ghs_kort", `${ok}\n`, `${ok}\r\nhost=evil.example`, ` ${ok}`, `${ok} x`, `${ok}:x`, `${ok}@h`, `${ok}/x`, `${ok}"`, `${ok}'`,
      `sk-ant-api03-${"a".repeat(80)}`, RUNNER_TOKEN, `GHS_${"a".repeat(40)}`, `Bearer ${ok}`, `ghs_${"a".repeat(8189)}`, `${"a".repeat(40)}`
    ];
    for (const value of bad) {
      const err = (await caught(checkout(h, { tokenFor: async () => value as string }))) as Error;
      expect(err, JSON.stringify(value)?.slice(0, 30)).toBeInstanceOf(HostJobRunnerError);
      expect(err.message, JSON.stringify(value)?.slice(0, 30)).toBe("host_job_runner_error:git_credential_unavailable:token_format_invalid");
    }
    expect(h.fake.calls.some((c: { args: string[] }) => c.args[0] === "create")).toBe(false);
    expect(h.service.manager.activeJobs).toBe(0);
  });

  it("gyldige ytterverdier (20 og 8192 tegn, alle tre prefikser) sendes", async () => {
    const h = await harness({ ...requestRepo, runner: { max_body_bytes: 65536, max_concurrent_jobs: 8 } });
    for (const value of [`ghs_${"a".repeat(16)}`, `ghp_${"b1".repeat(18)}`, `github_pat_${"c".repeat(40)}`, `ghs_${"d".repeat(8188)}`]) {
      const sandbox = await runnerFor(h, { tokenFor: async () => value }).create();
      expect((await sandbox.gitCheckout!({ repoUrl: REPO })).baseBranch).toBe("main");
      await sandbox.dispose();
    }
  });

  it("samme verdi som tokenet i jobb-env ville havnet i containeren: stoppes i klienten (git_token_in_env) FØR noe sendes", async () => {
    const h = await harness(requestRepo);
    const err = (await caught(checkout(h, { tokenFor: async () => T1 }, {}, { MIN_INNSTILLING: `prefiks ${T1} suffiks` }))) as Error;
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "git_token_in_env" });
    expect(err.message).not.toContain(T1);
    expect(h.fake.calls.some((c: { args: string[] }) => c.args[0] === "create")).toBe(false);
  });

  it("konfigurasjon: en kilde uten tokenFor() er en konfigfeil (lukket), og resolveJobSandboxRunner gir da FailClosedSandboxRunner", () => {
    expect(() => new HostJobSandboxRunner({ socketPath: "/run/x.sock", tokenFile: "/etc/x", gitCredentialSource: {} as unknown as HostGitCredentialSource })).toThrow(HostJobRunnerConfigError);
    const env = { JARVIS_JOB_RUNNER: "host", JARVIS_JOB_RUNNER_SOCKET: "/run/x.sock", JARVIS_JOB_RUNNER_TOKEN_FILE: "/etc/x" };
    const bad = resolveJobSandboxRunner(env, { gitCredentialSource: { tokenFor: "nei" } as unknown as HostGitCredentialSource });
    expect(bad).toBeInstanceOf(FailClosedSandboxRunner);
    expect((bad as FailClosedSandboxRunner).reason).toBe("git_credential_source_invalid");
  });
});

describe("C: resolveJobSandboxRunner viderefører kilden kun i host-modus", () => {
  it("host: kilden brukes (ende-til-ende mot en `request`-runner); uten kilde er oppførselen uendret; container/tom/ukjent modus ignorerer den", async () => {
    const h = await harness(requestRepo);
    const env = { JARVIS_JOB_RUNNER: "host", JARVIS_JOB_RUNNER_SOCKET: h.socketPath, JARVIS_JOB_RUNNER_TOKEN_FILE: h.tokenFile };
    const { calls, source } = rotatingSource();
    const runner = resolveJobSandboxRunner(env, { gitCredentialSource: source });
    expect(runner).toBeInstanceOf(HostJobSandboxRunner);
    const sandbox = await runner.create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    expect(calls).toEqual(["owner/repo"]);
    await sandbox.dispose();
    // uten kilde: samme runner-type, men ingen token -> `request`-repo nektes
    const plain = resolveJobSandboxRunner(env);
    expect(plain).toBeInstanceOf(HostJobSandboxRunner);
    const err = await caught((await plain.create()).gitCheckout!({ repoUrl: REPO }));
    expect(err).toMatchObject({ code: "git_token_required" });
    // andre moduser: en kilde gjør dem ikke mer tillatende
    for (const mode of [undefined, "", "container", "process", "docker"]) {
      const r = resolveJobSandboxRunner({ ...env, ...(mode === undefined ? { JARVIS_JOB_RUNNER: undefined } : { JARVIS_JOB_RUNNER: mode }) }, { gitCredentialSource: source });
      expect(r instanceof HostJobSandboxRunner, String(mode)).toBe(false);
      expect(r instanceof FailClosedSandboxRunner || r.name === "docker-job-container", String(mode)).toBe(true);
    }
  });
});

describe("D: tokenet gjengis aldri - heller ikke om runneren (mot formodning) ekkoer det, og heller ikke når git skriver det på stderr", () => {
  /** En falsk runner på et Unix-socket som svarer med en gitt feil. */
  async function fakeRunner(respond: (body: Record<string, unknown>) => { status: number; json: unknown }) {
    const dir = await makeTempDir("jr-fakerunner-");
    const socketPath = join(dir, "r.sock");
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
        bodies.push({ ...parsed, _auth: req.headers["authorization"] });
        const r = respond(parsed);
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify(r.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    cleanups.push(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
    return { dir, socketPath, bodies };
  }
  const tokenFileIn = async (dir: string): Promise<string> => {
    const { writeFile } = await import("node:fs/promises");
    const file = join(dir, "bearer");
    await writeFile(file, `${RUNNER_TOKEN}\n`, { mode: 0o600 });
    return file;
  };

  it("runneren ekkoer tokenet i feilkode og detalj: klienten erstatter det med [REDACTED] (klone og publish)", async () => {
    const fake = await fakeRunner((body) => {
      if (body["repo"] !== undefined) return { status: 201, json: { job_id: randomUUID(), head_sha: "a".repeat(40), base_branch: "main" } };
      return { status: 502, json: { error: `push_failed_${String(body["git_token"])}`, detail: `remote sa: ${String(body["git_token"])} er avvist` } };
    });
    const runner = new HostJobSandboxRunner({ socketPath: fake.socketPath, tokenFile: await tokenFileIn(fake.dir), gitCredentialSource: rotatingSource([T1, T2]).source });
    const sandbox = await runner.create();
    await sandbox.gitCheckout!({ repoUrl: REPO });
    const err = (await caught(sandbox.gitPublish!({ branch: "jarvis/x" }))) as HostJobRunnerError;
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(T2);
    expect(err.message).not.toContain(T2.slice(0, 20));
    expect(err.code).not.toContain(T2.slice(0, 20));
    // og forespørslene: bearer i header, tokenet KUN som `git_token` i klone-/publish-kroppen (aldri i env eller andre felt)
    expect(fake.bodies).toHaveLength(2);
    expect(fake.bodies[0]).toMatchObject({ repo: "owner/repo", git_token: T1, env: {}, _auth: `Bearer ${RUNNER_TOKEN}` });
    expect(fake.bodies[1]).toMatchObject({ branch: "jarvis/x", git_token: T2, _auth: `Bearer ${RUNNER_TOKEN}` });
    expect(Object.keys(fake.bodies[0] as object).sort()).toEqual(["_auth", "env", "git_token", "repo"]);
    expect(Object.keys(fake.bodies[1] as object).sort()).toEqual(["_auth", "branch", "git_token"]);
  });

  it("uten kilde inneholder verken klone- eller publish-kroppen et git_token-felt (ingen credential forlater worker som standard)", async () => {
    const fake = await fakeRunner((body) => body["repo"] !== undefined
      ? { status: 201, json: { job_id: randomUUID(), head_sha: "b".repeat(40), base_branch: "main" } }
      : { status: 200, json: { branch: "jarvis/x", commit_sha: "c".repeat(40), base_sha: "b".repeat(40), commits: 1, files_changed: 1 } });
    const sandbox = await new HostJobSandboxRunner({ socketPath: fake.socketPath, tokenFile: await tokenFileIn(fake.dir) }).create({ A_SETTING: "v" });
    await sandbox.gitCheckout!({ repoUrl: REPO });
    await sandbox.gitPublish!({ branch: "jarvis/x" });
    expect(fake.bodies.map((b) => Object.keys(b).filter((k) => k !== "_auth").sort())).toEqual([["env", "repo"], ["branch"]]);
  });

  it("serveren reflekterer passordet i en git-protokollfeil (git skriver hele tokenet på stderr): feilen klienten ser inneholder det aldri", async () => {
    const server = await gitServer([{ pass: T1 }], "fetch");
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...requestRepo, remote: { protocol: "http", host: server.host } });
    const err = (await caught(checkoutWith(runnerFor(h, rotatingSource([T1]).source)))) as Error;
    expect(err).toBeInstanceOf(HostJobRunnerError);
    expect(err).toMatchObject({ code: "git_network_failed", status: 502 });
    expect(err.message).toContain("[REDACTED]");
    expect(err.message).not.toContain(T1.slice(0, 20));
    expect(h.logLines.join("\n")).not.toContain(T1.slice(0, 20));
  });
});

describe("E: createCodingHandler med GitHub App-lignende kilde (ende-til-ende: klone, agent, test, commit, publish, PR)", () => {
  const identity: IdentityContext = {
    person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
    session_id: "sess-wpc1-token", device_id: "dev-pc", channel: "web", auth_strength: "active"
  };
  const contract = (): JobContract => ({
    task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "legg til CHANGES.md", acceptance_criteria: ["fullfører"],
    input: { data: { repo_url: "https://github.com/owner/repo" }, trust_level: "internal", provenance: "test" } as JobContract["input"],
    allowed_tools: ["github"], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: "coding", model_budget_ore: 1000,
    retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
  });
  const claimed = (c: JobContract): ClaimedTask => ({ task_id: c.task_id, tenant_id: c.tenant_id, contract: c, attempts: 1, checkpoint: null });
  const ctx: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };

  it("handleren henter ALDRI et token selv (host-modus); klienten henter ett per git-operasjon, og branchen havner på serveren med riktig fingeravtrykk", async () => {
    const server = await gitServer([{ pass: T1 }, { pass: T2 }]);
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...requestRepo, remote: { protocol: "http", host: server.host } });
    const { calls, source } = rotatingSource();
    const secretCalls: string[] = [];
    const handler = createCodingHandler({
      sandbox: runnerFor(h, source),
      agent: new ScriptedCodingAgent(),
      artifacts: { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore,
      policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
      identityFor: () => identity,
      claudeCodeCredential: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return ref === "ANTHROPIC_API_KEY" ? "sk-ant-api03-test-hemmelig" : null; } } },
      gitAuth: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return "ghp_SkalAldriHentesIHostModus0123456789"; } } },
      allowedRepos: ["owner/repo"],
      github: { gateway: { execute: async () => ({ ok: true, external_id: "7", data: { number: "7", html_url: "https://github.com/owner/repo/pull/7", created: true }, output_trust: "internal", deduplicated: false }) } as PrPublishingGateway }
    });
    const c = contract();
    const result = await handler(claimed(c), ctx);
    expect(result).toMatchObject({ branch: `jarvis/${c.task_id}`, tests: "passed" });
    expect(secretCalls).toEqual(["ANTHROPIC_API_KEY"]); // git-referansen slås aldri opp i host-modus
    expect(calls).toEqual(["owner/repo", "owner/repo"]); // ett token til klonen, ett FERSKT til pushen
    await wait(() => server.events.some((e) => e.op === "push"));
    expect(new Set(server.events.filter((e) => e.ev === "auth" && e.op === "fetch").map((e) => e.h))).toEqual(new Set([fingerprint(T1)]));
    expect(new Set(server.events.filter((e) => e.ev === "auth" && e.op === "push").map((e) => e.h))).toEqual(new Set([fingerprint(T2)]));
    expect(gitSync(`${server.reposRoot}/owner/repo.git`, ["rev-parse", `jarvis/${c.task_id}`])).toBe(result["commit_sha"]);
    // containeren fikk Claude-nøkkelen (jobbens egen env) men aldri et git-token
    const create = (h.fake.calls as Array<{ args: string[]; env: Record<string, string> }>).find((x) => x.args[0] === "create")!;
    expect(create.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-test-hemmelig");
    for (const t of [T1, T2]) {
      expect(JSON.stringify(create.env)).not.toContain(t);
      expect(create.args.join(" ")).not.toContain(t);
      expect(h.logLines.join("\n")).not.toContain(t);
    }
  }, 60_000);

  it("kilden svikter ved publish (App nede): jobben feiler lukket med git_credential_unavailable, ingenting pushes, og ingen jobb/container er igjen", async () => {
    const server = await gitServer([{ pass: T1 }]);
    server.createBareRepo("owner/repo.git");
    const h = await harness({ ...requestRepo, remote: { protocol: "http", host: server.host } });
    let n = 0;
    const handler = createCodingHandler({
      sandbox: runnerFor(h, { tokenFor: async () => { n += 1; if (n === 1) return T1; throw Object.assign(new Error("GitHub 503"), { code: "GITHUB_APP_TOKEN_UNAVAILABLE" }); } }),
      agent: new ScriptedCodingAgent(),
      artifacts: { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore,
      policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
      identityFor: () => identity,
      allowedRepos: ["owner/repo"]
    });
    const c = contract();
    const err = (await caught(handler(claimed(c), ctx))) as Error;
    expect(err.message).toBe("host_job_runner_error:git_credential_unavailable:GITHUB_APP_TOKEN_UNAVAILABLE");
    expect(spawnSync("git", ["-C", `${server.reposRoot}/owner/repo.git`, "branch", "--list", "jarvis/*"], { encoding: "utf8" }).stdout.trim()).toBe("");
    expect(h.service.manager.activeJobs).toBe(0);
    expect(h.fake.containers.size).toBe(0);
  }, 60_000);
});
