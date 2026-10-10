import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { IdentityContext, JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  HostJobSandboxRunner, JobCancelledError, ScriptedCodingAgent, createCodingHandler, guardGitCredentialSource,
  type ArtifactStore, type ClaimedTask, type CodingAgentAdapter, type HostGitCredentialSource, type JobContext, type PrPublishingGateway, type Sandbox, type SandboxRunner
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
  /** Hver `isRevoked(ref)`-sjekk, i rekkefølge. */
  revokedChecks: string[];
}

interface WireOptions {
  runner?: (real: HostJobSandboxRunner) => SandboxRunner;
  allowedRepos?: string[];
  harnessOptions?: unknown;
  /** WP-C3 F3 / B-M2: eierens per-credential-tilbakekalling (`owner_controls.revoke_credential`). */
  isRevoked?: (ref: string) => Promise<boolean>;
  gitAuthRef?: string;
  /** Ingen `gitAuth` i det hele tatt (W4: repo-allowlisten gjelder også da i host-modus). */
  withoutGitAuth?: boolean;
  agent?: CodingAgentAdapter;
  killSwitch?: KillSwitch;
  /** `source: request` (WP-C3): kilde til kortlevde, repo-scopede tokens som klienten sender i klone-/publish-forespørselen. */
  gitCredentialSource?: HostGitCredentialSource;
}

async function wire(options: WireOptions = {}): Promise<Wiring> {
  const h = (await createHarness(options.harnessOptions)) as Harness;
  harnesses.push(h);
  const real = new HostJobSandboxRunner({ socketPath: h.socketPath, tokenFile: h.tokenFile, ...(options.gitCredentialSource ? { gitCredentialSource: options.gitCredentialSource } : {}) });
  const runner = options.runner ? options.runner(real) : real;
  const revokedChecks: string[] = [];
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
    agent: options.agent ?? new ScriptedCodingAgent(),
    artifacts: { save: async (_t: string, _task: string, kind: string, name: string, content: string) => { artifacts.push({ kind, name, content }); }, list: async () => [] } as unknown as ArtifactStore,
    policy: new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch: options.killSwitch ?? new KillSwitch(), mandates: new Set(["git:push_branch"]) }),
    identityFor: () => identity,
    // Samme secret-provider for begge: i host-modus skal git-referansen ALDRI slås opp, kun Claude-nøkkelen (jobbens egen env).
    claudeCodeCredential: { secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return ref === "ANTHROPIC_API_KEY" ? "sk-ant-api03-test-hemmelig" : workerSideValue; } } },
    ...(options.withoutGitAuth ? {} : {
      gitAuth: {
        secretProvider: { get: async (ref: string) => { secretCalls.push(ref); return workerSideValue; } },
        ...(options.gitAuthRef !== undefined ? { ref: options.gitAuthRef } : {}),
        ...(options.isRevoked ? { isRevoked: async (ref: string) => { revokedChecks.push(ref); return (options.isRevoked as (r: string) => Promise<boolean>)(ref); } } : {})
      }
    }),
    allowedRepos: options.allowedRepos ?? ["owner/repo"],
    github: { gateway }
  });
  return { h, runner, secretCalls, artifacts, gatewayCalls, handler, revokedChecks };
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
    let seenExpectedSha: string | undefined;
    const spy: SandboxRunner = {
      name: "spy", hostGit: true,
      create: async (env, meta) => {
        const s = await w.runner.create(env, meta);
        return {
          ...s,
          gitPublish: async (r) => {
            seenConfig = (await s.exec("cat", [".git/config"])).stdout;
            seenExpectedSha = r.expectedSha;
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
    expect(seenExpectedSha, "B-L6: handleren sender SHA-en den selv leste i containeren").toMatch(/^[0-9a-f]{40}$/);
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

const dockerCreates = (w: Wiring): number => (w.h.fake.calls as Array<{ args: string[] }>).filter((c) => c.args[0] === "create").length;
const originRefs = (w: Wiring): string => spawnSync("git", ["for-each-ref", "--format=%(refname)"], { cwd: w.h.origins["owner/repo"].dir, encoding: "utf8" }).stdout;

describe("D: eierens revoke_credential gjelder også i host-modus (WP-C1 review B-M2)", () => {
  it("reviewerens repro: isRevoked() = true stopper jobben FØR runneren får beskjed om å klone - ingen jobb, ingen container, ingenting publisert", async () => {
    const w = await wire({ isRevoked: async () => true });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("git_auth_revoked");
    expect(w.revokedChecks).toEqual(["JARVIS_GITHUB_TOKEN"]); // før: 0 kall - jobben fullførte og publiserte tross tilbakekalling
    expect(dockerCreates(w)).toBe(0);
    expect(w.h.service.manager.activeJobs).toBe(0);
    expect(originRefs(w)).not.toContain("jarvis/");
    expect(w.gatewayCalls).toEqual([]);
    expect(w.secretCalls).toEqual(["ANTHROPIC_API_KEY"]); // host-modus: git-referansen slås fortsatt aldri opp
  }, 60_000);

  it("sjekken kjøres FØR klone og FØR publish (to ganger) med riktig ref; en ikke-tilbakekalt credential gir normal flyt", async () => {
    const w = await wire({ isRevoked: async () => false, gitAuthRef: "MIN_GITHUB_REF" });
    const c = contract();
    const result = await w.handler(claimed(c), makeCtx());
    expect(result).toMatchObject({ branch: `jarvis/${c.task_id}`, tests: "passed" });
    expect(w.revokedChecks).toEqual(["MIN_GITHUB_REF", "MIN_GITHUB_REF"]);
  }, 60_000);

  it("tilbakekalt MIDT i jobben (etter klone, før publish): ingenting publiseres, containeren og katalogen ryddes", async () => {
    let calls = 0;
    const w = await wire({ isRevoked: async () => { calls += 1; return calls >= 2; } });
    const c = contract();
    await expect(w.handler(claimed(c), makeCtx())).rejects.toThrow("git_auth_revoked");
    expect(calls).toBe(2);
    expect(dockerCreates(w)).toBe(1); // klonen ble gjort (første sjekk besto) ...
    expect(originRefs(w)).not.toContain("jarvis/"); // ... men publish ble stoppet av den andre
    expect(w.h.fake.containers.size).toBe(0);
    expect(w.h.service.manager.activeJobs).toBe(0);
    expect(w.gatewayCalls).toEqual([]);
  }, 60_000);

  it("fail-closed: en sjekk som selv feiler (ved start eller før publish) gir git_auth_revocation_check_failed og stopper jobben", async () => {
    const atStart = await wire({ isRevoked: async () => { throw new Error("db nede"); } });
    await expect(atStart.handler(claimed(contract()), makeCtx())).rejects.toThrow("git_auth_revocation_check_failed");
    expect(dockerCreates(atStart)).toBe(0);
    let calls = 0;
    const atPublish = await wire({ isRevoked: async () => { calls += 1; if (calls >= 2) throw new Error("db nede"); return false; } });
    await expect(atPublish.handler(claimed(contract()), makeCtx())).rejects.toThrow("git_auth_revocation_check_failed");
    expect(originRefs(atPublish)).not.toContain("jarvis/");
    expect(atPublish.h.fake.containers.size).toBe(0);
  }, 60_000);

  it("source: request - tilbakekalt: kilden (tokenFor) kalles ALDRI og runneren får aldri en jobb; vakten rundt kilden gjør det samme uavhengig av hvem som kaller", async () => {
    const tokenCalls: string[] = [];
    const source = { tokenFor: async (slug: string): Promise<string> => { tokenCalls.push(slug); return `ghs_${"A".repeat(40)}`; } };
    const w = await wire({ harnessOptions: { requestTokenSlugs: ["owner/repo"] }, isRevoked: async () => true, gitCredentialSource: source });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("git_auth_revoked");
    expect(tokenCalls).toEqual([]);
    expect(dockerCreates(w)).toBe(0);

    // vakten alene (uten coding.ts): revoked -> ingen utstedelse; sjekken feiler -> ingen utstedelse; ellers videre til kilden
    const direct = async (isRevoked: () => Promise<boolean>) => guardGitCredentialSource(source, isRevoked).tokenFor("owner/repo");
    await expect(direct(async () => true)).rejects.toMatchObject({ code: "GIT_AUTH_REVOKED" });
    await expect(direct(async () => { throw new Error("db nede med hemmelig tekst"); })).rejects.toMatchObject({ code: "GIT_AUTH_REVOCATION_CHECK_FAILED" });
    expect(tokenCalls).toEqual([]);
    await expect(direct(async () => false)).resolves.toMatch(/^ghs_/);
    expect(tokenCalls).toEqual(["owner/repo"]);
  }, 60_000);

  it("HostJobSandboxRunner med vakt: en tilbakekalt credential gir host_job_runner_error:git_credential_unavailable:GIT_AUTH_REVOKED (kun stabil kode) og ingen jobb hos runneren", async () => {
    const h = (await createHarness({ requestTokenSlugs: ["owner/repo"] })) as Harness;
    harnesses.push(h);
    const guarded = guardGitCredentialSource({ tokenFor: async () => `ghs_${"B".repeat(40)}` }, async () => true);
    const runner = new HostJobSandboxRunner({ socketPath: h.socketPath, tokenFile: h.tokenFile, gitCredentialSource: guarded });
    const sandbox = await runner.create({});
    await expect((sandbox.gitCheckout as NonNullable<Sandbox["gitCheckout"]>)({ repoUrl: "https://github.com/owner/repo" })).rejects.toThrow("host_job_runner_error:git_credential_unavailable:GIT_AUTH_REVOKED");
    expect(h.service.manager.activeJobs).toBe(0);
    expect((h.fake.calls as Array<{ args: string[] }>).some((c) => c.args[0] === "create")).toBe(false);
  });
});

describe("E: policy og allowlist håndheves i host-modus (WP-C1 review W2, W4)", () => {
  it("W2: kill switch aktivert MIDT i jobben (etter agenten): policy vurderes på nytt rett før publish - ingen branch publiseres", async () => {
    const killSwitch = new KillSwitch();
    class MidRunAgent extends ScriptedCodingAgent {
      override async modify(run: Parameters<ScriptedCodingAgent["modify"]>[0], goal: string): Promise<string> {
        const description = await super.modify(run, goal);
        killSwitch.activate("review: kill switch midt i jobben");
        return description;
      }
    }
    const w = await wire({ agent: new MidRunAgent(), killSwitch });
    const c = contract();
    await expect(w.handler(claimed(c), makeCtx())).rejects.toThrow("policy_denied:kill_switch_active");
    expect(gitSync(w.h.origins["owner/repo"].dir as string, ["branch", "--list", `jarvis/${c.task_id}`])).toBe("");
    expect(w.h.fake.containers.size).toBe(0);
    expect(w.gatewayCalls).toEqual([]);
  }, 60_000);

  it("W4: repo-allowlisten gjelder også i host-modus UTEN gitAuth - fremmed repo og tom liste avvises før noe opprettes; allowlistet repo går", async () => {
    const w = await wire({ withoutGitAuth: true, allowedRepos: ["owner/annet"] });
    await expect(w.handler(claimed(contract()), makeCtx())).rejects.toThrow("coding_input_rejected:git_repo_not_allowlisted");
    expect(dockerCreates(w)).toBe(0);
    const empty = await wire({ withoutGitAuth: true, allowedRepos: [] });
    await expect(empty.handler(claimed(contract()), makeCtx())).rejects.toThrow("coding_input_rejected:git_repo_allowlist_empty");
    expect(dockerCreates(empty)).toBe(0);
    const ok = await wire({ withoutGitAuth: true });
    const c = contract();
    await expect(ok.handler(claimed(c), makeCtx())).resolves.toMatchObject({ branch: `jarvis/${c.task_id}` });
  }, 60_000);
});
