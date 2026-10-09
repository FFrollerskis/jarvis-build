import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  HostJobSandboxRunner, JobCancelledError, ScriptedCodingAgent, createCodingHandler,
  type ArtifactStore, type ClaimedTask, type JobContext, type PrPublishingGateway, type Sandbox, type SandboxRunner
} from "@jarvis/tasks";
// @ts-expect-error - .mjs uten typer (ops/job-runner)
import { createHarness, gitSync } from "../../../ops/job-runner/test/support/harness.mjs";

/**
 * WP-C1: `createCodingHandler` mot den EKTE vertstjenesten (over Unix-socket, fake docker, ekte git mot lokalt bare-repo).
 * Kjerneegenskapen: i host-modus hentes og sendes INGEN git-credential noensinne - verken til workeren, til sandboxen eller til
 * jobb-containeren. Alt øvrig i handleren (validering, policy, agent, test, commit, PR) er uendret.
 */

type Harness = Awaited<ReturnType<typeof createHarness>>;
const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.close()));
});

const identity: IdentityContext = {
  person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal",
  session_id: "sess-wpc1", device_id: "dev-pc", channel: "web", auth_strength: "active"
};
const workerSideValue = "ghp_WorkerSideValueNeverReal0123456789";

function contract(overrides: Partial<JobContract> = {}, data: Record<string, unknown> = { repo_url: "https://github.com/owner/repo" }): JobContract {
  return {
    task_id: `task-${randomUUID()}`, owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "legg til CHANGES.md",
    acceptance_criteria: ["fullfører"], input: { data, trust_level: "internal", provenance: "test" } as JobContract["input"],
    allowed_tools: ["github"], allowed_memory_spaces: ["personal"], allowed_network_targets: [], agent_profile: "coding",
    model_budget_ore: 1000, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3, ...overrides
  };
}
const claimed = (c: JobContract): ClaimedTask => ({ task_id: c.task_id, tenant_id: c.tenant_id, contract: c, attempts: 1, checkpoint: null });
const makeCtx = (assertNotCancelled: () => Promise<void> = async () => undefined): JobContext => ({ attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled });

interface Wiring {
  h: Harness;
  runner: SandboxRunner;
  secretCalls: string[];
  artifacts: Array<{ kind: string; name: string; content: string }>;
  gatewayCalls: Array<Record<string, unknown>>;
  handler: ReturnType<typeof createCodingHandler>;
}

async function wire(options: { runner?: (real: HostJobSandboxRunner) => SandboxRunner; allowedRepos?: string[]; harnessOptions?: unknown } = {}): Promise<Wiring> {
  const h = (await createHarness(options.harnessOptions)) as Harness;
  harnesses.push(h);
  const real = new HostJobSandboxRunner({ socketPath: h.socketPath, tokenFile: h.tokenFile });
  const runner = options.runner ? options.runner(real) : real;
  const secretCalls: string[] = [];
  const artifacts: Wiring["artifacts"] = [];
  const gatewayCalls: Array<Record<string, unknown>> = [];
  const gateway: PrPublishingGateway = {
    execute: async (request) => {
      gatewayCalls.push(request.parameters);
      return { ok: true, external_id: "7", data: { number: "7", html_url: "https://github.com/owner/repo/pull/7", created: true }, output_trust: "internal", deduplicated: false };
    }
  };
  const handler = createCodingHandler({
    sandbox: runner,
    agent: new ScriptedCodingAgent(),
    artifacts: { save: async (_t: string, _task: string, kind: string, name: string, content: string) => { artifacts.push({ kind, name, content }); }, list: async () => [] } as unknown as ArtifactStore,
    policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
    identityFor: () => identity,
    // Samme secret-provider for begge: i host-modus skal git-referansen ALDRI slås opp, kun Claude-nøkkelen (jobbens egen env).
    claudeCodeCredential: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return ref === "ANTHROPIC_API_KEY" ? "sk-ant-api03-test-hemmelig" : workerSideValue; } } },
    gitAuth: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return workerSideValue; } } },
    allowedRepos: options.allowedRepos ?? ["owner/repo"],
    github: { gateway }
  });
  return { h, runner, secretCalls, artifacts, gatewayCalls, handler };
}

describe("A: ende-til-ende i host-modus", () => {
  it("klone, agent, test, commit, publish og PR - uten at noe git-token hentes eller sendes noe sted", async () => {
    const w = await wire();
    const c = contract();
    const result = await w.handler(claimed(c), makeCtx());
    expect(result).toMatchObject({ branch: `jarvis/${c.task_id}`, tests: "passed", pr: { status: "created", pr_number: "7" } });

    // branchen finnes på «GitHub» med EXAKT den committen handleren rapporterer
    const origin = w.h.origins["owner/repo"].dir as string;
    expect(gitSync(origin, ["rev-parse", `jarvis/${c.task_id}`])).toBe(result["commit_sha"]);
    expect(gitSync(origin, ["show", `jarvis/${c.task_id}:CHANGES.md`])).toContain("legg til CHANGES.md");
    expect(gitSync(origin, ["rev-parse", "main"])).toBe(w.h.origins["owner/repo"].head); // main urørt

    // INGEN git-credential: git-referansen ble aldri slått opp i workeren; kun Claude-nøkkelen (jobb-env) ble hentet
    expect(w.secretCalls).toEqual(["ANTHROPIC_API_KEY"]);
    expect(w.secretCalls).not.toContain("JARVIS_GITHUB_TOKEN");

    // og verdien finnes ingen steder i docker-kallene (args/env), runnerens logg eller origin-config
    for (const call of w.h.fake.calls as Array<{ args: string[]; env: Record<string, string> }>) {
      expect(call.args.join(" ")).not.toContain(workerSideValue);
      expect(JSON.stringify(call.env)).not.toContain(workerSideValue);
      for (const name of ["JARVIS_GIT_CREDENTIAL_TOKEN", "GIT_ASKPASS", "GITHUB_TOKEN", "JARVIS_GITHUB_TOKEN"]) expect(name in call.env, name).toBe(false);
    }
    expect(w.h.logLines.join("\n")).not.toContain(workerSideValue);
    // Claude-nøkkelen (jobb-env) ligger i docker-prosessens env ved create - aldri i argv
    const create = (w.h.fake.calls as Array<{ args: string[]; env: Record<string, string> }>).find((x) => x.args[0] === "create")!;
    expect(create.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-api03-test-hemmelig");
    expect(create.args.join(" ")).not.toContain("sk-ant-api03-test-hemmelig");

    // PR ble publisert for jobb-branchen (uendret D-95-flyt) og artefaktene er lagret
    expect(w.gatewayCalls).toEqual([{ repo: "owner/repo", branch: `jarvis/${c.task_id}`, title: "jarvis: legg til CHANGES.md", base: "main", body: expect.any(String) }]);
    expect(w.artifacts.map((a) => a.kind).sort()).toEqual(["patch", "pr-proposal", "pr-result", "test-log"]);

    // sporbarhet og opprydding: containeren var merket med task-id og er borte, katalogen er borte
    expect(w.h.fake.containers.size).toBe(0);
    expect(w.h.service.manager.activeJobs).toBe(0);
    const labels = (w.h.fake.calls as Array<{ args: string[] }>).find((x) => x.args[0] === "create")!.args;
    expect(labels).toContain(`jarvis.task_id=${c.task_id}`);
  }, 60_000);

  it("kloning skjer på verten: arbeidskopien i containeren har verken remote, credential eller runner-sti", async () => {
    const w = await wire();
    let seenConfig = "";
    const spy: SandboxRunner = {
      name: "spy", hostGit: true,
      create: async (env, meta) => {
        const s = await w.runner.create(env, meta);
        return {
          ...s,
          gitPublish: async (r) => {
            seenConfig = (await s.exec("cat", [".git/config"])).stdout;
            return (s.gitPublish as NonNullable<Sandbox["gitPublish"]>)(r);
          }
        } as Sandbox;
      }
    };
    const handler = createCodingHandler({
      sandbox: spy, agent: new ScriptedCodingAgent(), artifacts: { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore,
      policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
      identityFor: () => identity, allowedRepos: ["owner/repo"],
      gitAuth: { secretProvider: { get: async () => workerSideValue } }
    });
    await handler(claimed(contract({ allowed_tools: [] })), makeCtx());
    expect(seenConfig).toContain("[core]");
    expect(seenConfig).not.toMatch(/\[remote /);
    expect(seenConfig).not.toContain(workerSideValue);
    expect(seenConfig).not.toContain(w.h.root);
  }, 60_000);
});

describe("B: validering og feil lukker uten bivirkninger", () => {
  it("repo utenfor worker-allowlisten: avvist FØR sandbox opprettes (ingen jobb hos runneren)", async () => {
    const w = await wire({ allowedRepos: ["owner/annet"] });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("coding_input_rejected:git_repo_not_allowlisted");
    expect(w.h.fake.calls.some((c: { args: string[] }) => c.args[0] === "create")).toBe(false);
    expect(w.secretCalls).toEqual([]);
  });

  it("tom allowlist feiler lukket også i host-modus (git_repo_allowlist_empty); fremmed vert/transport avvises", async () => {
    const w = await wire({ allowedRepos: [] });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("coding_input_rejected:git_repo_allowlist_empty");
    for (const repo_url of ["https://evil.example/owner/repo", "file:///etc", "git@github.com:owner/repo", "--upload-pack=x", "https://github.com/owner/repo/extra"]) {
      await expect(w.handler(claimed(contract({}, { repo_url })), makeCtx()), repo_url).rejects.toThrow(/^coding_input_rejected:/);
    }
    expect(w.h.service.manager.activeJobs).toBe(0);
  });

  it("repo som worker tillater men runneren ikke har på SIN allowlist: jobben feiler (runnerens policy er den bindende)", async () => {
    const w = await wire({ allowedRepos: ["owner/repo", "owner/ikke-hos-runner"] });
    await expect(w.handler(claimed(contract({}, { repo_url: "https://github.com/owner/ikke-hos-runner" })), makeCtx())).rejects.toThrow(/repo_not_allowed/);
    expect(w.h.fake.containers.size).toBe(0);
  });

  it("kansellering før publish: ingenting pushes, containeren og katalogen ryddes", async () => {
    const w = await wire();
    let calls = 0;
    const c = contract();
    await expect(w.handler(claimed(c), makeCtx(async () => { calls += 1; if (calls === 3) throw new JobCancelledError(); }))).rejects.toBeInstanceOf(JobCancelledError);
    const refs = spawnSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: w.h.origins["owner/repo"].dir, encoding: "utf8" }).stdout;
    expect(refs).not.toContain("jarvis/");
    expect(w.h.fake.containers.size).toBe(0);
    expect(w.h.service.manager.activeJobs).toBe(0);
  }, 60_000);

  it("testene feiler: ingen publish, jobben feiler, containeren ryddes", async () => {
    const w = await wire();
    const c = contract({}, { repo_url: "https://github.com/owner/repo", test_command: ["node", "finnes-ikke.js"] });
    await expect(w.handler(claimed(c), makeCtx())).rejects.toThrow(/^tests_failed/);
    expect(w.gatewayCalls).toEqual([]);
    expect(w.h.fake.containers.size).toBe(0);
  }, 60_000);

  it("publisert SHA som ikke er den handleren så i containeren: published_commit_mismatch (artefakt og push må stemme overens)", async () => {
    const w = await wire({
      runner: (real) => ({
        name: "mismatch", hostGit: true,
        create: async (env, meta) => {
          const s = await real.create(env, meta);
          return { ...s, gitPublish: async (r) => ({ ...(await (s.gitPublish as NonNullable<Sandbox["gitPublish"]>)(r)), commitSha: "0".repeat(40) }) } as Sandbox;
        }
      })
    });
    await expect(w.handler(claimed(contract({ allowed_tools: [] })), makeCtx())).rejects.toThrow("published_commit_mismatch");
    expect(w.h.fake.containers.size).toBe(0);
  }, 60_000);

  it("runner med hostGit men uten gitCheckout/gitPublish: host_git_not_supported_by_sandbox", async () => {
    const w = await wire({
      runner: () => ({ name: "halv", hostGit: true, create: async () => ({ workdir: "/w", exec: async () => ({ code: 0, stdout: "", stderr: "" }), dispose: async () => undefined }) })
    });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("host_git_not_supported_by_sandbox");
  });
});

describe("C: uendret flyt uten hostGit", () => {
  it("en runner uten hostGit får gitAuth-tokenet hentet (eksisterende D-103-flyt) - kontrast som viser at hostGit er det som skrur det av", async () => {
    const secretCalls: string[] = [];
    const noHost: SandboxRunner = { name: "ikke-host", create: async () => { throw new Error("sandbox_not_needed_for_this_check"); } };
    const handler = createCodingHandler({
      sandbox: noHost, agent: new ScriptedCodingAgent(), artifacts: { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore,
      policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
      identityFor: () => identity, allowedRepos: ["owner/repo"],
      gitAuth: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return workerSideValue; } } }
    });
    await expect(handler(claimed(contract()), makeCtx())).rejects.toThrow("sandbox_not_needed_for_this_check");
    expect(secretCalls).toEqual(["JARVIS_GITHUB_TOKEN"]); // uten hostGit hentes tokenet som før
  });
});
