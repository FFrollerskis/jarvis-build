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
  /** `/status` + `/check-runs` for én SHA. */
  const ci = (status: unknown, runs: unknown) => async (url: string) =>
    url.includes("/check-runs") ? jsonResponse(runs) : jsonResponse(status);
  const run = (conclusion: string | null, status = "completed") => ({ status, conclusion });

  it("A1: getCombinedCiStatus - statuser + check-runs, fail-closed (D-397)", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    // statuser grønne + én grønn check-run -> success
    vi.stubGlobal("fetch", ci({ state: "success", total_count: 1 }, { check_runs: [run("success")], total_count: 1 }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("success");
    // failure/error-status -> failure uansett check-runs
    vi.stubGlobal("fetch", ci({ state: "failure", total_count: 1 }, { check_runs: [run("success")] }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    vi.stubGlobal("fetch", ci({ state: "error", total_count: 1 }, { check_runs: [] }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    // en feilet check-run (f.eks. gitleaks) -> failure selv om statusene er grønne
    vi.stubGlobal("fetch", ci({ state: "success", total_count: 1 }, { check_runs: [run("success"), run("failure")] }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    vi.stubGlobal("fetch", ci({ state: "pending", total_count: 0 }, { check_runs: [run("timed_out")] }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("failure");
    // ikke-ferdig check-run -> pending
    vi.stubGlobal("fetch", ci({ state: "success", total_count: 1 }, { check_runs: [run(null, "in_progress")] }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("pending");
    // kun Actions (ingen legacy-statuser): grønne check-runs -> success; skipped/neutral teller som grønt
    vi.stubGlobal("fetch", ci({ state: "pending", total_count: 0 }, { check_runs: [run("success"), run("skipped"), run("neutral")], total_count: 3 }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("success");
    // INGEN CI i det hele tatt er IKKE grønt
    vi.stubGlobal("fetch", ci({ state: "pending", total_count: 0 }, { check_runs: [], total_count: 0 }));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("pending");
    // svar uten check_runs er ukjent, aldri grønt
    vi.stubGlobal("fetch", ci({ state: "success", total_count: 1 }, {}));
    expect(await client.getCombinedCiStatus("o/r", "sha1")).toBe("pending");
    // flere check-runs enn én side -> aldri en delvis grønn
    vi.stubGlobal("fetch", ci({ state: "pending", total_count: 0 }, { check_runs: [run("success")], total_count: 150 }));
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

  it("A3b: filliste pagineres (var kuttet ved 100) - side 2 leses, og taket (3000) feiler LUKKET i stedet for en delmengde", async () => {
    const client = new HttpSelfModificationGithubClient("tok");
    const page = (n: number, count: number) => Array.from({ length: count }, (_, i) => ({ filename: `p${n}-${i}.ts` }));
    const seenPages: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const n = Number(new URL(url).searchParams.get("page"));
      seenPages.push(String(n));
      return jsonResponse(n === 1 ? page(1, 100) : n === 2 ? page(2, 100) : page(3, 5));
    });
    const files = await client.getPullRequestChangedFiles("o/r", "1");
    expect(files).toHaveLength(205);
    expect(files).toContain("p3-4.ts");
    expect(seenPages).toEqual(["1", "2", "3"]);
    // Alltid fulle sider: 30 sider = 3000 filer = GitHubs tak, listen kan ikke bevises komplett.
    vi.stubGlobal("fetch", async () => jsonResponse(page(1, 100)));
    await expect(client.getPullRequestChangedFiles("o/r", "1")).rejects.toThrow("self_modification_github_files_truncated");
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
    vi.stubGlobal("fetch", async (url: string, init: { headers: Record<string, string> }) => {
      seenAuth.push(init.headers["authorization"] ?? "");
      return url.includes("/check-runs") ? jsonResponse({ check_runs: [{ status: "completed", conclusion: "success" }], total_count: 1 }) : jsonResponse({ state: "success", total_count: 1 });
    });
    const client = new ResolvingSelfModificationGithubClient(async () => tokens[call++] ?? null);
    await client.getCombinedCiStatus("o/r", "sha1");
    await client.getCombinedCiStatus("o/r", "sha1");
    // Hvert CI-kall gjør to forespørsler (status + check-runs); tokenet oppløses på nytt for hver KLIENT-metode, ikke per forespørsel.
    expect(seenAuth).toEqual(["Bearer token-1", "Bearer token-1", "Bearer token-2", "Bearer token-2"]);
  });

  it("B3: delegerer korrekt til alle fire metodene", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.includes("/check-runs")) return jsonResponse({ check_runs: [{ status: "completed", conclusion: "success" }], total_count: 1 });
      if (url.includes("/status")) return jsonResponse({ state: "success", total_count: 1 });
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
