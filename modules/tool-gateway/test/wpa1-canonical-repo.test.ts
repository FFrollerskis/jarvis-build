import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS, type IdentityContext } from "@jarvis/contracts";
import {
  CONNECTOR_REGISTRY,
  buildStatusSource,
  configuredGithubRepo,
  curatedReadOnlyMeshTools,
  githubRepoLockViolation,
  resolveGithubRepo,
  type ToolGateway
} from "../src/index.ts";

/**
 * WP-A1 (D-478/D-479, JARVIS-117 a/b): ÉN kilde for det kanoniske GitHub-repoet (`CANONICAL_GITHUB_REPO` i `@jarvis/contracts`). Alle standarder følger den, og
 * `JARVIS_GITHUB_REPO` (eierens innstilling på NAS-en) vinner alltid. Her: standardene i kildekoden (lås, oppløsning, daglig oppsummering, connector-test, mesh-verktøy).
 */
const ENV = "JARVIS_GITHUB_REPO";
let saved: string | undefined;
beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV]; });
afterEach(() => { if (saved === undefined) delete process.env[ENV]; else process.env[ENV] = saved; });

const OWNER = "FFrollerskis";
const identity = { tenant_id: "t", person_id: "p", memory_space_id: "personal", session_id: "s" } as unknown as IdentityContext;

describe("kontrakten", () => {
  it("kanonisk repo er `eier/navn` og står ikke blant de gamle (frosne) repoene", () => {
    expect(CANONICAL_GITHUB_REPO).toBe("FFrollerskis/jarvis-build");
    expect(/^[^/\s]+\/[^/\s]+$/.test(CANONICAL_GITHUB_REPO)).toBe(true);
    expect(LEGACY_GITHUB_REPOS).toContain("tsworkflow/jarvisbuild");
    for (const legacy of LEGACY_GITHUB_REPOS) {
      expect(/^[^/\s]+\/[^/\s]+$/.test(legacy), legacy).toBe(true);
      expect(legacy.toLowerCase()).not.toBe(CANONICAL_GITHUB_REPO.toLowerCase());
    }
  });
});

describe("configuredGithubRepo / resolveGithubRepo: standarden er det kanoniske repoet", () => {
  it("uten, tom eller ugyldig JARVIS_GITHUB_REPO brukes det kanoniske repoet; en gyldig verdi vinner (trimmet)", () => {
    expect(configuredGithubRepo({})).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepo({ [ENV]: "" })).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepo({ [ENV]: "   " })).toBe(CANONICAL_GITHUB_REPO);
    for (const bad of ["jarvisbuild", "a/b/c", "ikke et repo", "/x", "x/", "owner /repo"]) {
      expect(configuredGithubRepo({ [ENV]: bad }), bad).toBe(CANONICAL_GITHUB_REPO);
    }
    expect(configuredGithubRepo({ [ENV]: "acme/app" })).toBe("acme/app");
    expect(configuredGithubRepo({ [ENV]: "  acme/app  " })).toBe("acme/app");
  });

  it("lese-handlinger uten repo faller til det kanoniske repoet; et navn uten eier får det kanoniske repoets eier; skrive-handlinger får aldri standardrepo", () => {
    expect(resolveGithubRepo("list_pull_requests", undefined, undefined)).toBe(CANONICAL_GITHUB_REPO);
    expect(resolveGithubRepo("list_pull_requests", "", undefined)).toBe(CANONICAL_GITHUB_REPO);
    expect(resolveGithubRepo("get_commit", "jarvis-build", undefined)).toBe(`${OWNER}/jarvis-build`);
    expect(resolveGithubRepo("get_commit", "annet", undefined)).toBe(`${OWNER}/annet`);
    expect(resolveGithubRepo("list_branches", "evil/exfil", undefined)).toBe("evil/exfil");
    expect(() => resolveGithubRepo("create_branch", undefined, undefined)).toThrow("github_missing_parameter:repo");
    // Eierens innstilling vinner over standarden.
    expect(resolveGithubRepo("list_pull_requests", undefined, "acme/app")).toBe("acme/app");
    expect(resolveGithubRepo("get_commit", "app", "acme/app")).toBe("acme/app");
    // Ugyldig innstilling = standarden (som låsen).
    expect(resolveGithubRepo("list_pull_requests", undefined, "ugyldig")).toBe(CANONICAL_GITHUB_REPO);
  });
});

describe("GitHub-repolåsen (Q-50 B) følger standarden", () => {
  it("standard: det kanoniske repoet er innenfor; det gamle frosne repoet er et brudd for modellen (eieren kan åpne det med JARVIS_GITHUB_REPO)", () => {
    expect(githubRepoLockViolation("list_branches", undefined, {})).toBeNull();
    expect(githubRepoLockViolation("list_branches", CANONICAL_GITHUB_REPO, {})).toBeNull();
    expect(githubRepoLockViolation("list_branches", CANONICAL_GITHUB_REPO.toUpperCase(), {})).toBeNull();
    for (const legacy of LEGACY_GITHUB_REPOS) {
      expect(githubRepoLockViolation("list_branches", legacy, {}), legacy).toEqual({ requested: legacy, allowed: CANONICAL_GITHUB_REPO });
    }
    // Eieren velger selv det gamle repoet: da er DET innenfor og det kanoniske et brudd.
    const legacyEnv = { [ENV]: LEGACY_GITHUB_REPOS[0] as string };
    expect(githubRepoLockViolation("list_branches", LEGACY_GITHUB_REPOS[0] as string, legacyEnv)).toBeNull();
    expect(githubRepoLockViolation("list_branches", CANONICAL_GITHUB_REPO, legacyEnv)).toEqual({ requested: CANONICAL_GITHUB_REPO, allowed: LEGACY_GITHUB_REPOS[0] });
  });

  it("låsen og oppløsningen er enige: hver lese-handling uten repo havner innenfor låsen (standard og med eierens innstilling)", () => {
    for (const action of ["get_branch", "get_commit", "get_pull_request", "list_branches", "list_pull_requests", "list_workflow_jobs", "list_workflow_runs", "read_repo_meta"]) {
      expect(githubRepoLockViolation(action, undefined, {}), action).toBeNull();
      expect(githubRepoLockViolation(action, undefined, { [ENV]: "acme/app" }), action).toBeNull();
      expect(githubRepoLockViolation(action, undefined, { [ENV]: "ugyldig" }), action).toBeNull();
    }
  });
});

describe("kallere som tidligere hadde repoet hardkodet eller sin egen standard (JARVIS-117 a/b)", () => {
  function fakeGateway(): { gateway: ToolGateway; calls: Array<{ tool_id: string; action: string; parameters: Record<string, unknown> }> } {
    const calls: Array<{ tool_id: string; action: string; parameters: Record<string, unknown> }> = [];
    const gateway = {
      async execute(req: { tool_id: string; action: string; parameters: Record<string, unknown> }) {
        calls.push({ tool_id: req.tool_id, action: req.action, parameters: req.parameters });
        return { ok: true, data: { issues: [] } };
      }
    } as unknown as ToolGateway;
    return { gateway, calls };
  }

  it("daglig oppsummering (buildStatusSource) leser issues fra det KONFIGURERTE repoet (var hardkodet), ellers det kanoniske", async () => {
    const run = async (): Promise<unknown> => {
      const { gateway, calls } = fakeGateway();
      await buildStatusSource(gateway, "/finnes/ikke/PROJECT_STATUS.md").collect(identity);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ tool_id: "github", action: "read_issues" });
      return calls[0]?.parameters["repo"];
    };
    expect(await run()).toBe(CANONICAL_GITHUB_REPO);
    process.env[ENV] = "acme/app";
    expect(await run()).toBe("acme/app");
    process.env[ENV] = "ikke et repo";
    expect(await run()).toBe(CANONICAL_GITHUB_REPO);
    // Samme repo som låsen tillater: daglig oppsummering og modellflaten kan ikke peke ulike steder.
    process.env[ENV] = "acme/app";
    expect(githubRepoLockViolation("read_issues", await run() as string, process.env)).toBeNull();
  });

  it("connector-registerets live-test for GitHub og mesh-verktøyet read_github_issues bruker samme standard som låsen", () => {
    const github = CONNECTOR_REGISTRY.find((c) => c.id === "github");
    expect(github?.live_test?.tool_id).toBe("github");
    const mesh = curatedReadOnlyMeshTools().find((t) => t.def.name === "read_github_issues");
    expect(mesh?.tool_id).toBe("github");
    for (const [env, expected] of [[undefined, CANONICAL_GITHUB_REPO], ["acme/app", "acme/app"], ["ugyldig verdi", CANONICAL_GITHUB_REPO]] as const) {
      if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
      expect(github?.live_test?.parameters(identity), String(env)).toEqual({ repo: expected });
      expect(mesh?.parameters?.({}), String(env)).toEqual({ repo: expected });
    }
  });
});
