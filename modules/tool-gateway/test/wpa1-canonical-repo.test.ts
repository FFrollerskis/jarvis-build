import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, FORMER_CANONICAL_GITHUB_REPOS, LEGACY_GITHUB_REPOS, PRODUCTION_GITHUB_REPO_NAMES, type IdentityContext } from "@jarvis/contracts";
import {
  CONNECTOR_REGISTRY,
  buildStatusSource,
  configuredGithubRepo,
  curatedReadOnlyMeshTools,
  githubRepoLockViolation,
  isProductionGithubRepo,
  productionGithubRepoKeys,
  resolveGithubRepo,
  type ToolGateway
} from "../src/index.ts";
import { resolveLiveRepo } from "../scripts/ua5-github-live.ts";

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
    // Compose setter variabelen TOM som standard (`JARVIS_GITHUB_REPO: ${JARVIS_GITHUB_REPO:-}`): tom/blank verdi skal gi standarden, aldri et tomt repo (JARVIS-117 a).
    for (const blank of ["", "   "]) {
      process.env[ENV] = blank;
      expect(await run(), JSON.stringify(blank)).toBe(CANONICAL_GITHUB_REPO);
    }
    process.env[ENV] = "  acme/app \n";
    expect(await run()).toBe("acme/app");
    // Samme repo som låsen tillater: daglig oppsummering og modellflaten kan ikke peke ulike steder.
    process.env[ENV] = "acme/app";
    expect(githubRepoLockViolation("read_issues", await run() as string, process.env)).toBeNull();
  });

  it("connector-registerets live-test for GitHub og mesh-verktøyet read_github_issues bruker samme standard som låsen", () => {
    const github = CONNECTOR_REGISTRY.find((c) => c.id === "github");
    expect(github?.live_test?.tool_id).toBe("github");
    const mesh = curatedReadOnlyMeshTools().find((t) => t.def.name === "read_github_issues");
    expect(mesh?.tool_id).toBe("github");
    const table: ReadonlyArray<readonly [string | undefined, string]> = [
      [undefined, CANONICAL_GITHUB_REPO], ["", CANONICAL_GITHUB_REPO], ["   ", CANONICAL_GITHUB_REPO],
      ["acme/app", "acme/app"], ["  acme/app ", "acme/app"],
      ["ugyldig verdi", CANONICAL_GITHUB_REPO], ["https://github.com/acme/app", CANONICAL_GITHUB_REPO]
    ];
    for (const [env, expected] of table) {
      if (env === undefined) delete process.env[ENV]; else process.env[ENV] = env;
      expect(github?.live_test?.parameters(identity), JSON.stringify(env)).toEqual({ repo: expected });
      expect(mesh?.parameters?.({}), JSON.stringify(env)).toEqual({ repo: expected });
    }
  });
});

describe("én definisjon av «konfigurert repo»: oppløsning, lås, connector-test og mesh-verktøy er enige for HVER verdi av JARVIS_GITHUB_REPO", () => {
  const VALUES: ReadonlyArray<string | undefined> = [
    undefined, "", "   ", "\t", "acme/app", "  acme/app  ", "Acme/App", "acme/app.git", "acme/app/", "ugyldig", "a/b/c",
    "https://github.com/acme/app", "acme /app", "/app", "acme/", LEGACY_GITHUB_REPOS[0], CANONICAL_GITHUB_REPO
  ];

  it("hver verdi gir samme repo overalt (uten at låsen flagger en lese-handling uten repo)", () => {
    const github = CONNECTOR_REGISTRY.find((c) => c.id === "github");
    const mesh = curatedReadOnlyMeshTools().find((t) => t.def.name === "read_github_issues");
    for (const value of VALUES) {
      const label = JSON.stringify(value);
      if (value === undefined) delete process.env[ENV]; else process.env[ENV] = value;
      const env: Record<string, string | undefined> = value === undefined ? {} : { [ENV]: value };
      const expected = configuredGithubRepo(env);
      expect(resolveGithubRepo("list_pull_requests", undefined), `${label} (standardparameter = process.env)`).toBe(expected);
      expect(resolveGithubRepo("list_pull_requests", undefined, value), `${label} (eksplisitt)`).toBe(expected);
      expect(githubRepoLockViolation("list_pull_requests", undefined, env), label).toBeNull();
      expect(githubRepoLockViolation("list_pull_requests", expected, env), label).toBeNull();
      expect(github?.live_test?.parameters(identity), label).toEqual({ repo: expected });
      expect(mesh?.parameters?.({}), label).toEqual({ repo: expected });
    }
  });
});

describe("repolåsen er hermetisk mot `env`-argumentet (process.env lekker ikke inn)", () => {
  const UNLOCK = "JARVIS_GITHUB_ALLOW_OTHER_REPOS";
  let savedUnlock: string | undefined;
  beforeEach(() => { savedUnlock = process.env[UNLOCK]; delete process.env[UNLOCK]; });
  afterEach(() => { if (savedUnlock === undefined) delete process.env[UNLOCK]; else process.env[UNLOCK] = savedUnlock; });

  it("et env-argument uten JARVIS_GITHUB_REPO betyr standarden, ikke process.env; et env-argument MED nøkkelen vinner over process.env; uten argument gjelder process.env", () => {
    process.env[ENV] = "acme/fra-process-env";
    // `{}`: tillatt repo = standarden, og en lese-handling uten repo løses til standarden (før rettingen falt oppløsningen til process.env og ga et falskt brudd).
    expect(githubRepoLockViolation("list_branches", undefined, {})).toBeNull();
    expect(githubRepoLockViolation("list_branches", CANONICAL_GITHUB_REPO, {})).toBeNull();
    expect(githubRepoLockViolation("list_branches", "acme/fra-process-env", {})).toEqual({ requested: "acme/fra-process-env", allowed: CANONICAL_GITHUB_REPO });
    // Tom nøkkel i argumentet er også «standarden».
    expect(githubRepoLockViolation("list_branches", undefined, { [ENV]: "" })).toBeNull();
    // Nøkkel i argumentet vinner over process.env.
    expect(githubRepoLockViolation("list_branches", undefined, { [ENV]: "acme/eksplisitt" })).toBeNull();
    expect(githubRepoLockViolation("list_branches", "acme/fra-process-env", { [ENV]: "acme/eksplisitt" })).toEqual({ requested: "acme/fra-process-env", allowed: "acme/eksplisitt" });
    // Uten argument (standard = process.env) gjelder process.env, på begge sider av sammenligningen.
    expect(githubRepoLockViolation("list_branches", undefined)).toBeNull();
    expect(githubRepoLockViolation("list_branches", "acme/fra-process-env")).toBeNull();
    expect(githubRepoLockViolation("list_branches", CANONICAL_GITHUB_REPO)).toEqual({ requested: CANONICAL_GITHUB_REPO, allowed: "acme/fra-process-env" });
  });
});

describe("daglig oppsummering: en GitHub-lesing som feiler er UKJENT, ikke «ingen issues» (D-396-prinsippet)", () => {
  function gatewayReturning(result: unknown): ToolGateway {
    return { async execute() { return result; } } as unknown as ToolGateway;
  }

  it("feilet lesing (credential mangler, Issues av -> 410 m.m.) gir et eget element med repoet og årsaken; vellykket lesing gir ingen slik markering", async () => {
    const failed = await buildStatusSource(gatewayReturning({ ok: false, reason: "credential_unavailable" }), "/finnes/ikke/PROJECT_STATUS.md").collect(identity);
    const marker = failed.find((item) => item.ref === "issues-unavailable");
    expect(marker).toMatchObject({ source: "github", title: "GitHub-issues utilgjengelige", score: 20 });
    expect(marker?.detail).toContain(CANONICAL_GITHUB_REPO);
    expect(marker?.detail).toContain("credential_unavailable");
    expect(marker?.detail).toContain("UKJENT");
    const ok = await buildStatusSource(gatewayReturning({ ok: true, data: { issues: [] } }), "/finnes/ikke/PROJECT_STATUS.md").collect(identity);
    expect(ok.find((item) => item.ref === "issues-unavailable")).toBeUndefined();
    // Uten gateway (ingen GitHub-kilde i det hele tatt) lages ingen markering.
    const none = await buildStatusSource(null, "/finnes/ikke/PROJECT_STATUS.md").collect(identity);
    expect(none.find((item) => item.ref === "issues-unavailable")).toBeUndefined();
  });
});

describe("felles produksjonsvern for skrivende live-/akseptanse-skript (github-sandbox-guard)", () => {
  it("de faste produksjonsnavnene, repoet JARVIS_GITHUB_REPO peker på og ekstra allowlist nektes i alle skrivemåter; sandbox-navn som bare ligner nektes ikke", () => {
    for (const name of PRODUCTION_GITHUB_REPO_NAMES) {
      for (const variant of [name, name.toUpperCase(), `${name}.git`, `${name}/`, ` ${name} `, `${name}.git.git`, `${name.toUpperCase()}.GIT`]) {
        expect(isProductionGithubRepo(variant, {}), variant).toBe(true);
      }
    }
    expect(PRODUCTION_GITHUB_REPO_NAMES).toEqual(expect.arrayContaining([CANONICAL_GITHUB_REPO, ...LEGACY_GITHUB_REPOS, ...FORMER_CANONICAL_GITHUB_REPOS]));
    expect(isProductionGithubRepo("acme/prod", { [ENV]: "Acme/Prod.git" })).toBe(true);
    expect(isProductionGithubRepo("acme/ekstra", {}, ["ACME/Ekstra"])).toBe(true);
    for (const sandbox of ["acme/sandbox", "FFrollerskis/jarvis-sandbox", "ffrollerskis/jarvis-build-test", "tsworkflow/jarvisbuild-test", "owner/repo.github.io", "", ".git", "/"]) {
      expect(isProductionGithubRepo(sandbox, {}), JSON.stringify(sandbox)).toBe(false);
    }
    // En tom/ugyldig env-verdi gir aldri en tom nøkkel i mengden (da ville et tomt navn «matche»).
    expect([...productionGithubRepoKeys({ [ENV]: ".git" })].every((key) => key.length > 0)).toBe(true);
  });

  it("ua5-github-live: repo er PÅKREVD (ingen standard) og produksjonsrepoer nektes; et eget sandbox-repo godtas", () => {
    expect(resolveLiveRepo([], {})).toMatchObject({ ok: false });
    expect(resolveLiveRepo(["  "], {})).toMatchObject({ ok: false });
    for (const bad of ["ikke-et-repo", "a/b/c", "https://github.com/a/b", "../x/y"]) expect(resolveLiveRepo([bad], {}), bad).toMatchObject({ ok: false });
    for (const name of PRODUCTION_GITHUB_REPO_NAMES) {
      for (const variant of [name, name.toUpperCase(), `${name}.git`, `${name}.git.git`]) {
        const r = resolveLiveRepo([variant], {});
        expect(r, variant).toMatchObject({ ok: false });
        expect(r.ok ? "" : r.reason, variant).toContain("produksjonsrepo");
      }
    }
    expect(resolveLiveRepo(["acme/prod"], { [ENV]: "acme/prod" })).toMatchObject({ ok: false });
    expect(resolveLiveRepo(["acme/andre"], { JARVIS_GIT_ALLOWED_REPOS: "acme/mitt, ACME/Andre.git" })).toMatchObject({ ok: false });
    expect(resolveLiveRepo(["acme/sandbox"], { [ENV]: "acme/prod", JARVIS_GIT_ALLOWED_REPOS: "acme/prod" })).toEqual({ ok: true, repo: "acme/sandbox" });
  });
});
