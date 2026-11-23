import { describe, expect, it } from "vitest";
import { CANONICAL_GITHUB_REPO, LEGACY_GITHUB_REPOS, configuredGithubRepoFromEnv, githubRepoAliasKey, parseGithubRepoSlug } from "../src/index.ts";

/** WP-A1 (D-479): den felles definisjonen av et gyldig `JARVIS_GITHUB_REPO` og av alias-nøkkelen i produksjonsvern. */
describe("parseGithubRepoSlug", () => {
  it("godtar `eier/navn` (trimmet) og bevarer skrivemåten", () => {
    expect(parseGithubRepoSlug("acme/app")).toBe("acme/app");
    expect(parseGithubRepoSlug("  acme/app \n")).toBe("acme/app");
    expect(parseGithubRepoSlug("ACME/App.git")).toBe("ACME/App.git");
    expect(parseGithubRepoSlug(CANONICAL_GITHUB_REPO)).toBe(CANONICAL_GITHUB_REPO);
  });
  it("avviser alt annet (tom, blanke, URL, a/b/c, mellomrom i navn, tom side, ikke-streng)", () => {
    for (const bad of ["", "   ", "jarvis-build", "a/b/c", "https://github.com/acme/app", "acme/app/", "acme app/x", "acme/ app", "acme/", "/app", "//", "a//b"]) {
      expect(parseGithubRepoSlug(bad), JSON.stringify(bad)).toBeNull();
    }
    for (const notString of [undefined, null, 0, 1, true, {}, [], ["acme/app"], Symbol.iterator]) expect(parseGithubRepoSlug(notString)).toBeNull();
  });
});

describe("configuredGithubRepoFromEnv", () => {
  it("standard når variabelen mangler, er tom (compose-standarden) eller er ugyldig; ellers eierens verdi", () => {
    expect(configuredGithubRepoFromEnv({})).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: undefined })).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: "" })).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: "   " })).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: "https://github.com/acme/app" })).toBe(CANONICAL_GITHUB_REPO);
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: " acme/app " })).toBe("acme/app");
    expect(configuredGithubRepoFromEnv({ JARVIS_GITHUB_REPO: LEGACY_GITHUB_REPOS[0] as string })).toBe(LEGACY_GITHUB_REPOS[0]);
  });
  it("leser kun JARVIS_GITHUB_REPO (andre nøkler påvirker ikke)", () => {
    expect(configuredGithubRepoFromEnv({ JARVIS_GIT_ALLOWED_REPOS: "acme/app", GITHUB_REPOSITORY: "acme/app" })).toBe(CANONICAL_GITHUB_REPO);
  });
});

describe("githubRepoAliasKey", () => {
  it("små bokstaver, trim og strip av `/` og `.git` til fikspunkt (alias av samme repo får samme nøkkel)", () => {
    const key = "ffrollerskis/jarvis-build";
    for (const alias of ["FFrollerskis/jarvis-build", " ffrollerskis/jarvis-build ", "ffrollerskis/jarvis-build.git", "ffrollerskis/jarvis-build/", "FFROLLERSKIS/JARVIS-BUILD.GIT", "ffrollerskis/jarvis-build.git/", "ffrollerskis/jarvis-build/.git", "ffrollerskis/jarvis-build.git.git", "ffrollerskis/jarvis-build.git/.git/"]) {
      expect(githubRepoAliasKey(alias), alias).toBe(key);
    }
  });
  it("skiller ulike repoer og endrer ikke navn som bare inneholder git", () => {
    expect(githubRepoAliasKey("owner/repo.github.io")).toBe("owner/repo.github.io");
    expect(githubRepoAliasKey("owner/mitt.git-repo")).toBe("owner/mitt.git-repo");
    expect(githubRepoAliasKey("owner/gitops")).toBe("owner/gitops");
    expect(githubRepoAliasKey("owner/a")).not.toBe(githubRepoAliasKey("owner/b"));
    expect(githubRepoAliasKey("")).toBe("");
    expect(githubRepoAliasKey(".git")).toBe("");
  });
  it("de gamle og det kanoniske repoet har ulik nøkkel", () => {
    const keys = [CANONICAL_GITHUB_REPO, ...LEGACY_GITHUB_REPOS].map(githubRepoAliasKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
