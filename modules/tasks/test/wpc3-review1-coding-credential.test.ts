import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { GitCredentialSource, JobContract } from "@jarvis/contracts";
import { InMemoryDeviceRegistry, InMemoryNonceStore, KillSwitch, PolicyGateway } from "@jarvis/policy";
import {
  GIT_CREDENTIAL_TOKEN_ENV, ProcessSandboxRunner, createCodingHandler,
  type ArtifactStore, type ClaimedTask, type CodingAgentAdapter, type CodingAgentExec, type ExecResult, type JobContext, type Sandbox, type SandboxRunner
} from "@jarvis/tasks";

/**
 * WP-C3, rettelser etter den uavhengige sikkerhetsreviewen (F2, F3, F13) i `createCodingHandler`: git-credentialen er REPO-SCOPET (`GitCredentialSource.tokenFor(<repoet jobben gjelder>)`),
 * hentes RETT FØR hver git-nettverksoperasjon (ikke én gang ved jobbstart), og utstedelsen respekterer per-credential-tilbakekalling og kill switch. Ekte `git` mot et lokalt bare-repo og
 * ekte `ProcessSandboxRunner`; ingen nettverk, ingen Postgres (artefaktlageret er en fake).
 */

const GITHUB_SHAPED_URL = "https://github.com/tsworkflow/jarvisbuild-wpc3-r1.git";
const SLUG = "tsworkflow/jarvisbuild-wpc3-r1";
const identity = { person_id: "person-tobias", tenant_id: "tenant-a", memory_space_id: "personal", session_id: "sess-wpc3-r1", device_id: "dev-pc", channel: "web", auth_strength: "active" } as const;
let bareRepo = "";

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} feilet: ${result.stderr}`);
  return result.stdout.trim();
}

beforeAll(async () => {
  bareRepo = await mkdtemp(join(tmpdir(), "jarvis-wpc3r1-origin-"));
  git(bareRepo, "init", "--bare", "--initial-branch=main", ".");
  const seed = await mkdtemp(join(tmpdir(), "jarvis-wpc3r1-seed-"));
  git(seed, "init", "--initial-branch=main", ".");
  git(seed, "config", "user.email", "seed@test");
  git(seed, "config", "user.name", "seed");
  spawnSync("node", ["-e", "require('fs').writeFileSync('README.md','# repo')"], { cwd: seed });
  git(seed, "add", "-A");
  git(seed, "commit", "-m", "init");
  git(seed, "push", bareRepo, "main");
}, 120_000);

interface CapturedCall { command: string; args: string[]; extraEnv: Record<string, string> | undefined }

class CapturingRedirectingSandboxRunner implements SandboxRunner {
  readonly name = "capturing-redirect-sandbox";
  readonly calls: CapturedCall[] = [];
  created = 0;
  constructor(private readonly inner: SandboxRunner, private readonly redirectFrom: string, private readonly redirectTo: string) {}
  async create(jobEnv?: Record<string, string>): Promise<Sandbox> {
    this.created += 1;
    const sandbox = await this.inner.create(jobEnv);
    return {
      workdir: sandbox.workdir,
      exec: async (command: string, args: string[], timeoutMs?: number, extraEnv?: Record<string, string>): Promise<ExecResult> => {
        let rewritten = args.map((a) => (a === this.redirectFrom ? this.redirectTo : a));
        if (command === "git") {
          const idx = rewritten.findIndex((a) => a === "clone" || a === "push");
          if (idx >= 0) rewritten = [...rewritten.slice(0, idx), "-c", "protocol.file.allow=always", ...rewritten.slice(idx)];
        }
        this.calls.push({ command, args: rewritten, extraEnv });
        return sandbox.exec(command, rewritten, timeoutMs, extraEnv);
      },
      dispose: () => sandbox.dispose()
    };
  }
  clone(): CapturedCall | undefined { return this.calls.find((c) => c.args.includes("clone")); }
  push(): CapturedCall | undefined { return this.calls.find((c) => c.args.includes("push")); }
}

/** Gjør en endring i arbeidstreet; `during` kjøres midt i agentkjøringen (etter clone, før push) - slik tilstand endrer seg i en lang jobb. */
class MidRunAgent implements CodingAgentAdapter {
  readonly name = "mid-run-agent";
  constructor(private readonly during: () => void | Promise<void> = () => undefined) {}
  async modify(exec: CodingAgentExec): Promise<string> {
    await this.during();
    await exec("node", ["-e", "require('fs').writeFileSync('CHANGES.md','endret')"]);
    return "endret CHANGES.md";
  }
}

function jobContract(taskId = `task-wpc3-r1-${randomBytes(4).toString("hex")}`): JobContract {
  return {
    task_id: taskId, owner_person_id: "person-tobias", tenant_id: "tenant-a", goal: "wpc3 review 1", acceptance_criteria: ["fullfører"],
    input: { data: { repo_url: GITHUB_SHAPED_URL }, trust_level: "internal", provenance: "test" }, allowed_tools: ["github"], allowed_memory_spaces: ["personal"],
    allowed_network_targets: [], agent_profile: "coding", model_budget_ore: 1000, retry_policy: { max_attempts: 1, backoff_seconds: 0 }, max_steps: 3
  } as JobContract;
}

function claimed(): ClaimedTask {
  const contract = jobContract();
  return { task_id: contract.task_id, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null };
}

const jobContext: JobContext = { attempts: 1, checkpoint: null, saveCheckpoint: async () => undefined, assertNotCancelled: async () => undefined };

function setup(options: {
  agent?: CodingAgentAdapter;
  credentialSource?: GitCredentialSource;
  secretProvider?: { get(ref: string): Promise<string | null> };
  isRevoked?: (ref: string) => Promise<boolean>;
  killSwitch?: KillSwitch;
  withoutGitAuth?: boolean;
  ref?: string;
}) {
  const sandbox = new CapturingRedirectingSandboxRunner(new ProcessSandboxRunner(), GITHUB_SHAPED_URL, bareRepo);
  const killSwitch = options.killSwitch ?? new KillSwitch();
  const policy = new PolicyGateway({ devices: new InMemoryDeviceRegistry(), nonces: new InMemoryNonceStore(), killSwitch, mandates: new Set(["git:push_branch"]) });
  const artifacts = { save: async () => undefined, list: async () => [] } as unknown as ArtifactStore;
  const handler = createCodingHandler({
    sandbox, agent: options.agent ?? new MidRunAgent(), artifacts, policy, identityFor: () => identity, allowedRepos: [SLUG],
    ...(options.withoutGitAuth ? {} : {
      gitAuth: {
        secretProvider: options.secretProvider ?? { get: async () => "ukjent-secretprovider-skal-ikke-brukes" },
        ...(options.ref ? { ref: options.ref } : {}),
        ...(options.credentialSource ? { credentialSource: options.credentialSource } : {}),
        ...(options.isRevoked ? { isRevoked: options.isRevoked } : {})
      }
    })
  });
  return { sandbox, handler, killSwitch };
}

/** En kilde som utsteder et NYTT, tydelig nummerert token for hvert kall og husker hva den ble spurt om. */
function rotatingSource() {
  const calls: string[] = [];
  const tokens: string[] = [];
  const source: GitCredentialSource = {
    tokenFor: async (slug) => {
      calls.push(slug);
      const token = `tok-${calls.length}-${randomBytes(6).toString("hex")}`;
      tokens.push(token);
      return token;
    }
  };
  return { source, calls, tokens };
}

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F2 + F13: git-credentialen er repo-scopet og hentes RETT FØR hver git-nettverksoperasjon", () => {
  it("F2a: credentialSource.tokenFor får NØYAKTIG repoet jobben gjelder (små bokstaver), og secretProvider (standard-scope) leses aldri", async () => {
    const src = rotatingSource();
    let secretReads = 0;
    const { handler } = setup({ credentialSource: src.source, secretProvider: { get: async () => { secretReads += 1; return "standard-scope-token"; } } });
    const result = await handler(claimed(), jobContext);
    expect(result["tests"]).toBe("passed");
    expect(src.calls.length).toBeGreaterThan(0);
    for (const slug of src.calls) expect(slug).toBe(SLUG);
    expect(secretReads).toBe(0);
  }, 60_000);

  it("F13a: tokenet hentes ved jobbstart (før sandbox), rett før clone OG rett før push - clone og push får hvert sitt ferske token, aldri det fra jobbstart", async () => {
    const src = rotatingSource();
    const { handler, sandbox } = setup({ credentialSource: src.source });
    await handler(claimed(), jobContext);
    expect(src.calls).toHaveLength(3); // jobbstart, clone, push
    const [atStart, atClone, atPush] = src.tokens as [string, string, string];
    expect(sandbox.clone()?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(atClone);
    expect(sandbox.push()?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(atPush);
    expect(new Set([atStart, atClone, atPush]).size).toBe(3);
    for (const call of sandbox.calls) {
      for (const arg of call.args) for (const token of src.tokens) expect(arg).not.toContain(token); // aldri i argv
      if (call !== sandbox.clone() && call !== sandbox.push()) expect(call.extraEnv).toBeUndefined();
    }
  }, 60_000);

  it("F13b: en jobb der agenten bruker lang tid - tokenet som gjelder ved push er hentet ETTER agentkjøringen, ikke før (kilden blir spurt på nytt)", async () => {
    const src = rotatingSource();
    let callsWhenAgentStarted = -1;
    const agent = new MidRunAgent(() => { callsWhenAgentStarted = src.calls.length; });
    const { handler, sandbox } = setup({ credentialSource: src.source, agent });
    await handler(claimed(), jobContext);
    expect(callsWhenAgentStarted).toBe(2); // jobbstart + clone er gjort når agenten starter
    expect(src.calls).toHaveLength(3); // push hentet sitt token først ETTER agent og tester
    expect(sandbox.push()?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe(src.tokens[2]);
  }, 60_000);

  it("F13c: også uten credentialSource (secretProvider-stien) leses credentialen på nytt før clone og push - en roterende kilde gir ulike tokens", async () => {
    let n = 0;
    const reads: string[] = [];
    const { handler, sandbox } = setup({ secretProvider: { get: async (ref) => { reads.push(ref); n += 1; return `pat-${n}`; } } });
    await handler(claimed(), jobContext);
    expect(reads).toEqual(["JARVIS_GITHUB_TOKEN", "JARVIS_GITHUB_TOKEN", "JARVIS_GITHUB_TOKEN"]);
    expect(sandbox.clone()?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe("pat-2");
    expect(sandbox.push()?.extraEnv?.[GIT_CREDENTIAL_TOKEN_ENV]).toBe("pat-3");
  }, 60_000);

  it("F2b: feiler utstedelsen, feiler jobben LUKKET før sandbox opprettes - kun den lukkede feilkoden (aldri kildens melding), aldri uautentisert git", async () => {
    const leaky: GitCredentialSource = { tokenFor: async () => { throw Object.assign(new Error("boom ghs_VIRKELIG_HEMMELIG_0123456789 fra leverandør"), { code: "GITHUB_APP_REQUEST_REJECTED" }); } };
    const { handler, sandbox } = setup({ credentialSource: leaky });
    const error = await handler(claimed(), jobContext).then(() => null, (err: Error) => err);
    expect(error?.message).toBe("git_auth_unavailable:GITHUB_APP_REQUEST_REJECTED");
    expect(sandbox.created).toBe(0);
    expect(sandbox.calls).toHaveLength(0);
    // En feil uten gyldig kode (eller med en kode som ikke ser ut som en kode) gir bare etiketten.
    for (const code of [undefined, "små bokstaver", "A", "X".repeat(80), 42]) {
      const odd: GitCredentialSource = { tokenFor: async () => { throw Object.assign(new Error("boom"), { code }); } };
      const result = await setup({ credentialSource: odd }).handler(claimed(), jobContext).then(() => null, (err: Error) => err);
      expect(result?.message, String(code)).toBe("git_auth_unavailable");
    }
  }, 60_000);

  it("F2c: en kilde som returnerer tom streng/null behandles som utilgjengelig - aldri en tom credential til git", async () => {
    for (const value of ["", null]) {
      const source = { tokenFor: async () => value } as unknown as GitCredentialSource;
      const { handler, sandbox } = setup({ credentialSource: source });
      await expect(handler(claimed(), jobContext)).rejects.toThrow("git_auth_unavailable");
      expect(sandbox.created).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("F3: tilbakekalling og kill switch stopper utstedelse av git-credential (ikke bare policy.authorize ved jobbstart)", () => {
  it("F3a: en tilbakekalt credential (isRevoked) stopper jobben FØR noe token utstedes og før sandbox opprettes", async () => {
    const src = rotatingSource();
    const asked: string[] = [];
    const { handler, sandbox } = setup({ credentialSource: src.source, isRevoked: async (ref) => { asked.push(ref); return true; } });
    await expect(handler(claimed(), jobContext)).rejects.toThrow("git_auth_revoked");
    expect(asked).toEqual(["JARVIS_GITHUB_TOKEN"]);
    expect(src.calls).toHaveLength(0); // ingen utstedelse
    expect(sandbox.created).toBe(0);
  });

  it("F3b: tilbakekalling som skjer ETTER clone stopper push: ingen push-utstedelse, ingen push, ingen jobb-branch i origin", async () => {
    const src = rotatingSource();
    let revoked = false;
    const taskId = `task-wpc3-r1-rev-${randomBytes(4).toString("hex")}`;
    const contract = jobContract(taskId);
    const { handler, sandbox } = setup({ credentialSource: src.source, isRevoked: async () => revoked, agent: new MidRunAgent(() => { revoked = true; }) });
    await expect(handler({ task_id: taskId, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null }, jobContext)).rejects.toThrow("git_auth_revoked");
    expect(src.calls).toHaveLength(2); // jobbstart + clone - men IKKE push
    expect(sandbox.clone()).toBeDefined();
    expect(sandbox.push()).toBeUndefined();
    expect(git(bareRepo, "branch", "--list", `jarvis/${taskId}`)).toBe("");
  }, 60_000);

  it("F3c: en kill switch som slås på under agentkjøringen stopper push (policy vurderes på nytt rett før push) - også uten gitAuth", async () => {
    for (const withoutGitAuth of [false, true]) {
      const src = rotatingSource();
      const killSwitch = new KillSwitch();
      const taskId = `task-wpc3-r1-ks-${randomBytes(4).toString("hex")}`;
      const contract = jobContract(taskId);
      const { handler, sandbox } = setup({ credentialSource: src.source, killSwitch, withoutGitAuth, agent: new MidRunAgent(() => killSwitch.activate("test midt i jobben")) });
      await expect(handler({ task_id: taskId, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null }, jobContext)).rejects.toThrow("policy_denied:kill_switch_active");
      expect(sandbox.push(), String(withoutGitAuth)).toBeUndefined();
      if (!withoutGitAuth) expect(src.calls).toHaveLength(2); // ingen push-utstedelse
      expect(git(bareRepo, "branch", "--list", `jarvis/${taskId}`), String(withoutGitAuth)).toBe("");
    }
  }, 60_000);

  it("F3d: en tilbakekallingssjekk som selv feiler regnes som «ikke bevist ikke-tilbakekalt» - jobben stopper lukket, uten utstedelse og uten kildens feilmelding", async () => {
    const src = rotatingSource();
    const { handler, sandbox } = setup({ credentialSource: src.source, isRevoked: async () => { throw new Error("db nede: password authentication failed for user jarvis"); } });
    const error = await handler(claimed(), jobContext).then(() => null, (err: Error) => err);
    expect(error?.message).toBe("git_auth_revocation_check_failed");
    expect(src.calls).toHaveLength(0);
    expect(sandbox.created).toBe(0);
  });

  it("F3f: tilbakekallingen sjekkes på den KONFIGURERTE credential-refen (gitAuth.ref), ikke en hardkodet - og secretProvider-stien leser samme ref", async () => {
    const asked: string[] = [];
    const read: string[] = [];
    const { handler } = setup({
      ref: "JARVIS_ANNEN_GIT_CREDENTIAL", secretProvider: { get: async (ref) => { read.push(ref); return "pat-for-annen-ref"; } },
      isRevoked: async (ref) => { asked.push(ref); return false; }
    });
    expect((await handler(claimed(), jobContext))["tests"]).toBe("passed");
    expect(asked).toEqual(["JARVIS_ANNEN_GIT_CREDENTIAL", "JARVIS_ANNEN_GIT_CREDENTIAL", "JARVIS_ANNEN_GIT_CREDENTIAL"]);
    expect(read).toEqual(["JARVIS_ANNEN_GIT_CREDENTIAL", "JARVIS_ANNEN_GIT_CREDENTIAL", "JARVIS_ANNEN_GIT_CREDENTIAL"]);
  }, 60_000);

  it("F3e: ikke tilbakekalt og ikke pauset - jobben fullføres som før, og sjekken stilles for hver av de tre utstedelsene", async () => {
    const src = rotatingSource();
    let checks = 0;
    const taskId = `task-wpc3-r1-ok-${randomBytes(4).toString("hex")}`;
    const contract = jobContract(taskId);
    const { handler } = setup({ credentialSource: src.source, isRevoked: async () => { checks += 1; return false; } });
    const result = await handler({ task_id: taskId, tenant_id: "tenant-a", contract, attempts: 1, checkpoint: null }, jobContext);
    expect(result["tests"]).toBe("passed");
    expect(checks).toBe(3);
    expect(git(bareRepo, "branch", "--list", `jarvis/${taskId}`)).toContain(`jarvis/${taskId}`);
  }, 60_000);
});
