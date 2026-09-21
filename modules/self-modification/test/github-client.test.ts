import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpSelfModificationGithubClient, ResolvingSelfModificationGithubClient } from "../src/github-client.ts";

/**
 * Task #121 (D-214): `fetch` stubbet - INGEN ekte GitHub-kontakt/token.
 * Beviser (1) korrekt REST-mapping for HTTP-klienten, og (2) at den
 * oppløsende innpakningen ALDRI cacher et token på tvers av kall - hvert
 * kall løser på nytt, og en manglende verdi kaster FØR noe HTTP-kall skjer.
 */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("A: HttpSelfModificationGithubClient - REST-mapping", () => {
  it("A1: getCombinedCiStatus mapper 'success'/'failure'/'error'/annet korrekt", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse({ state: "success" }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("success");
    vi.stubGlobal("fetch", async () => jsonResponse({ state: "failure" }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    vi.stubGlobal("fetch", async () => jsonResponse({ state: "error" }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    vi.stubGlobal("fetch", async () => jsonResponse({ state: "pending" }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("pending");
  });

  it("A2: getCombinedCiStatus kaster på non-ok HTTP-respons", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse({}, false, 500));
    await expect(client.getCombinedCiStatus("o/r", "sha1")).rejects.toThrow("self_modification_github_status_500");
  });

  it("A3: getPullRequestChangedFiles mapper filnavn fra respons-arrayet", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse([{ filename: "a.ts" }, { filename: "b.ts" }]));
    expect(await client.getPullRequestChangedFiles("o/r", "1")).toEqual(["a.ts", "b.ts"]);
  });

  it("A4: getPullRequestHeadSha returnerer head.sha, kaster hvis manglende", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse({ head: { sha: "abc123" } }));
    expect(await client.getPullRequestHeadSha("o/r", "1")).toBe("abc123");
    vi.stubGlobal("fetch", async () => jsonResponse({ head: {} }));
    await expect(client.getPullRequestHeadSha("o/r", "1")).rejects.toThrow("self_modification_github_pr_missing_head_sha");
  });

  it("A5: mergePullRequest - vellykket merge returnerer merged:true", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse({ merged: true, message: "merged" }));
    const result = await client.mergePullRequest("o/r", "1", { sha: "abc", commitTitle: "t" });
    expect(result).toEqual({ merged: true, message: "merged" });
  });

  it("A6: mergePullRequest - 405 (ikke mergbar nå) returnerer merged:false, kaster ALDRI", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    vi.stubGlobal("fetch", async () => jsonResponse({ message: "SHA stale" }, false, 405));
    const result = await client.mergePullRequest("o/r", "1", { sha: "abc", commitTitle: "t" });
    expect(result).toEqual({ merged: false, message: "SHA stale" });
  });
});

describe("B: ResolvingSelfModificationGithubClient - tokenet oppløses PÅ NYTT for hvert kall", () => {
  it("B1: manglende token kaster FØR noe HTTP-kall skjer", async () => {
    let fetchCalled = false;
    vi.stubGlobal("fetch", async () => { fetchCalled = true; return jsonResponse({}); });
    const client = new ResolvingSelfModificationGithubClient(async () => null);
    await expect(client.getCombinedCiStatus("o/r", "sha1")).rejects.toThrow("self_modification_git_auth_unavailable");
    expect(fetchCalled).toBe(false);
  });

  it("B2: en tokenrotasjon MELLOM to kall reflekteres - ALDRI et cachet, utdatert token", async () => {
    const tokens = ["token-1", "token-2"];
    let call = 0;
    const seenAuth: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { headers: Record<string, string> }) => {
      seenAuth.push(init.headers["authorization"] ?? "");
      return jsonResponse({ state: "success" });
    });
    const client = new ResolvingSelfModificationGithubClient(async () => tokens[call++] ?? null);
    await client.getCombinedCiStatus("o/r", "sha1");
    await client.getCombinedCiStatus("o/r", "sha1");
    expect(seenAuth).toEqual(["Bearer token-1", "Bearer token-2"]);
  });

  it("B3: delegerer korrekt til alle fire metodene", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/status")) return jsonResponse({ state: "success" });
      if (url.includes("/files")) return jsonResponse([{ filename: "x" }]);
      if (url.endsWith("/pulls/1")) return jsonResponse({ head: { sha: "s1" } });
      if (url.endsWith("/merge")) return jsonResponse({ merged: true });
      throw new Error(`unexpected_url:${url}`);
    });
    const client = new ResolvingSelfModificationGithubClient(async () => "tok");
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("success");
    expect(await client.getPullRequestChangedFiles("o/r", "1")).toEqual(["x"]);
    expect(await client.getPullRequestHeadSha("o/r", "1")).toBe("s1");
    expect(await client.mergePullRequest("o/r", "1", { sha: "s1", commitTitle: "t" })).toEqual({ merged: true });
  });
});
