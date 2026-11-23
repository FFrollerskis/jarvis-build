import { afterEach, describe, expect, it, vi } from "vitest";
import { CANONICAL_GITHUB_REPO } from "@jarvis/contracts";
import { GithubApiError, GithubTransport, resolveGithubRepo } from "../src/live-transports.ts";

/**
 * UA-5 GitHub Developer Control Plane v1: rene wiring-/kontraktstester
 * (INGEN embedded Postgres, global `fetch` mocket - samme mønster som
 * `google-ads-transport.test.ts`). Beviser: read_issues/read_repo_meta
 * UENDRET (GithubKnowledgeSource-avhengighet), full ny handlingsflate
 * (branch/PR/issue/workflow), idempotent håndtering av GitHub sine egne
 * 422-"already exists"-feil, bounded retry KUN på 429/5xx (respekterer
 * Retry-After), strukturelt vern mot sletting av beskyttede branches, og at
 * credential/feilkropp aldri lekker ufiltrert.
 */

const REPO = "tsworkflow/jarvisbuild";
const CTX = { identity: { person_id: "p1", tenant_id: "t1", session_id: "s1" } as never };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("A: read_issues/read_repo_meta UENDRET (GithubKnowledgeSource avhenger av nøyaktig denne formen)", () => {
  it("read_issues returnerer samme shape som før denne sliceen", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, [{ number: 5, title: "Bug", updated_at: "2026-08-20T00:00:00Z", pull_request: undefined }]));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("read_issues", { repo: REPO }, "tok", CTX);
    expect(result.data).toEqual({ issues: [{ id: "5", title: "Bug", at: "2026-08-20T00:00:00Z", is_pr: "false", ci_failing: "false" }] });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/${REPO}/issues?state=open&per_page=20`);
  });
  it("read_repo_meta returnerer samme shape som før denne sliceen", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { full_name: REPO, description: null, updated_at: "2026-08-20T00:00:00Z", default_branch: "main" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
    expect(result.data).toEqual({ full_name: REPO, description: "", updated_at: "2026-08-20T00:00:00Z", default_branch: "main" });
  });
});

describe("B: nye les-handlinger (klasse A)", () => {
  it("list_branches", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, [{ name: "main", commit: { sha: "abc" }, protected: true }])));
    const transport = new GithubTransport();
    const result = await transport.invoke("list_branches", { repo: REPO }, "tok", CTX);
    expect(result.data).toEqual({ branches: [{ name: "main", sha: "abc", protected: true }] });
  });
  it("get_branch", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { name: "main", commit: { sha: "abc" }, protected: true })));
    const transport = new GithubTransport();
    const result = await transport.invoke("get_branch", { repo: REPO, branch: "main" }, "tok", CTX);
    expect(result.data).toEqual({ name: "main", sha: "abc", protected: true });
  });
  it("get_commit", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { sha: "abc123", html_url: "https://x", commit: { message: "fix", author: { name: "jarvis", date: "2026-08-20T00:00:00Z" } } })));
    const transport = new GithubTransport();
    const result = await transport.invoke("get_commit", { repo: REPO, ref: "abc123" }, "tok", CTX);
    expect(result).toEqual({ external_id: "abc123", data: { sha: "abc123", message: "fix", author: "jarvis", date: "2026-08-20T00:00:00Z", html_url: "https://x" } });
  });
  it("list_pull_requests", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, [{ number: 1, title: "t", state: "open", head: { ref: "b", sha: "s" }, base: { ref: "main" }, html_url: "u" }])));
    const transport = new GithubTransport();
    const result = await transport.invoke("list_pull_requests", { repo: REPO }, "tok", CTX);
    expect(result.data).toEqual({ pull_requests: [{ number: 1, title: "t", state: "open", draft: false, head_ref: "b", head_sha: "s", base_ref: "main", html_url: "u", merged: false, mergeable: null, mergeable_state: null }] });
  });
  it("get_pull_request inkluderer mergeable_state", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { number: 7, title: "t", state: "open", head: { ref: "b", sha: "s" }, base: { ref: "main" }, html_url: "u", mergeable: true, mergeable_state: "clean" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("get_pull_request", { repo: REPO, pr_number: "7" }, "tok", CTX);
    expect(result.external_id).toBe("7");
    expect((result.data as { mergeable_state: string }).mergeable_state).toBe("clean");
  });
  it("list_workflow_runs", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { workflow_runs: [{ id: 99, name: "build-test", status: "completed", conclusion: "success", head_sha: "s", head_branch: "main", html_url: "u", created_at: "d" }] })));
    const transport = new GithubTransport();
    const result = await transport.invoke("list_workflow_runs", { repo: REPO, branch: "main", status: "completed" }, "tok", CTX);
    expect(result.data).toEqual({ workflow_runs: [{ id: "99", name: "build-test", status: "completed", conclusion: "success", head_sha: "s", head_branch: "main", html_url: "u", created_at: "d" }] });
  });
  it("get_workflow_run", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { id: 99, name: "build-test", status: "completed", conclusion: "failure", head_sha: "s", head_branch: "main", html_url: "u", created_at: "2026-08-22T10:00:00Z" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("get_workflow_run", { repo: REPO, run_id: "99" }, "tok", CTX);
    expect(result.external_id).toBe("99");
    expect((result.data as { conclusion: string }).conclusion).toBe("failure");
  });
  it("get_workflow_run returnerer providerens FAKTISKE created_at - D-105 kriterium 1 host-fix: deployment-ingestion.ts bruker DETTE feltet som deployed_at, ALDRI Date.now()", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { id: 100, name: "ci", status: "completed", conclusion: "success", head_sha: "abc123", head_branch: "main", html_url: "u", created_at: "2026-08-22T09:15:00Z" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("get_workflow_run", { repo: REPO, run_id: "100" }, "tok", CTX);
    expect((result.data as { created_at: string }).created_at).toBe("2026-08-22T09:15:00Z");
  });
  it("list_workflow_jobs rapporterer hvilket steg som feilet", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(200, { jobs: [{ id: 1, name: "test", status: "completed", conclusion: "failure", started_at: "a", completed_at: "b", steps: [{ name: "run tests", status: "completed", conclusion: "failure", number: 3 }] }] })));
    const transport = new GithubTransport();
    const result = await transport.invoke("list_workflow_jobs", { repo: REPO, run_id: "99" }, "tok", CTX);
    expect(result.data).toEqual({ jobs: [{ id: "1", name: "test", status: "completed", conclusion: "failure", started_at: "a", completed_at: "b", steps: [{ name: "run tests", status: "completed", conclusion: "failure", number: 3 }] }] });
  });
});

describe("C: create_branch - idempotent ved 422 already-exists, KUN når sha faktisk matcher", () => {
  it("oppretter branch normalt", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(201, { object: { sha: "newsha" } })));
    const transport = new GithubTransport();
    const result = await transport.invoke("create_branch", { repo: REPO, branch: "jarvis/x", from_sha: "basesha" }, "tok", CTX);
    expect(result).toEqual({ external_id: "newsha", data: { branch: "jarvis/x", sha: "newsha", created: true } });
  });
  it("422 already-exists MED SAMME sha slår opp eksisterende ref og returnerer suksess", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(422, { message: "Reference already exists" }))
      .mockResolvedValueOnce(jsonResponse(200, { object: { sha: "basesha" } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("create_branch", { repo: REPO, branch: "jarvis/x", from_sha: "basesha" }, "tok", CTX);
    expect(result).toEqual({ external_id: "basesha", data: { branch: "jarvis/x", sha: "basesha", created: false } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("422 already-exists MED ULIK sha kaster en stale-target-konflikt, ALDRI stille suksess", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(422, { message: "Reference already exists" }))
      .mockResolvedValueOnce(jsonResponse(200, { object: { sha: "someOTHERsha" } }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("create_branch", { repo: REPO, branch: "jarvis/x", from_sha: "basesha" }, "tok", CTX))
      .rejects.toMatchObject({ httpStatus: 409, retryable: false });
  });
  it.each(["main", "master", "production"])("nekter å opprette branch NAVNGITT '%s' UTEN noe HTTP-kall (symmetrisk med delete_branch)", async (branch) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("create_branch", { repo: REPO, branch, from_sha: "s" }, "tok", CTX)).rejects.toThrow("github_protected_branch_refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("D: create_pr - idempotent ved 422 already-exists, KUN når base faktisk matcher", () => {
  it("oppretter PR normalt", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(201, { number: 42, html_url: "https://pr/42" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("create_pr", { repo: REPO, branch: "jarvis/x", title: "fix" }, "tok", CTX);
    expect(result).toEqual({ external_id: "42", data: { number: "42", html_url: "https://pr/42", created: true } });
  });
  it("422 already-exists finner eksisterende åpen PR MED SAMME base (server-side filter, ikke bare første treff)", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(422, { message: "A pull request already exists for tsworkflow:jarvis/x." }))
      .mockResolvedValueOnce(jsonResponse(200, [{ number: 42, html_url: "https://pr/42" }]));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("create_pr", { repo: REPO, branch: "jarvis/x", title: "fix", base: "develop" }, "tok", CTX);
    expect(result).toEqual({ external_id: "42", data: { number: "42", html_url: "https://pr/42", created: false } });
    const lookupUrl = String(fetchMock.mock.calls[1]?.[0]);
    expect(lookupUrl).toContain("base=develop");
    expect(lookupUrl).toContain(`head=${encodeURIComponent("tsworkflow:jarvis/x")}`);
  });
  it("422 already-exists uten noe treff for angitt base rekaster den opprinnelige feilen (ingen ambiguity-gjetting)", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(422, { message: "A pull request already exists for tsworkflow:jarvis/x." }))
      .mockResolvedValueOnce(jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("create_pr", { repo: REPO, branch: "jarvis/x", title: "fix" }, "tok", CTX))
      .rejects.toMatchObject({ httpStatus: 422 });
  });
});

describe("E: PR/issue-metadata-skriving (klasse B)", () => {
  it("update_pr sender kun oppgitte felt", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { number: 1, title: "new", state: "open", head: { ref: "b", sha: "s" }, base: { ref: "main" }, html_url: "u" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await transport.invoke("update_pr", { repo: REPO, pr_number: "1", title: "new" }, "tok", CTX);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({ title: "new" });
  });
  it("comment_on_issue", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(201, { id: 555, html_url: "https://c/555" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("comment_on_issue", { repo: REPO, issue_number: "1", body: "hei" }, "tok", CTX);
    expect(result).toEqual({ external_id: "555", data: { id: "555", html_url: "https://c/555" } });
  });
  it("set_labels PUT-er hele settet (erstatter, ikke akkumulerer)", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, [{ name: "bug" }, { name: "priority" }]));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("set_labels", { repo: REPO, issue_number: "1", labels: ["bug", "priority"] }, "tok", CTX);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(result.data).toEqual({ labels: ["bug", "priority"] });
  });
  it("request_reviewers", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(201, { requested_reviewers: [{ login: "tobias" }] })));
    const transport = new GithubTransport();
    const result = await transport.invoke("request_reviewers", { repo: REPO, pr_number: "1", reviewers: ["tobias"] }, "tok", CTX);
    expect(result.data).toEqual({ requested_reviewers: ["tobias"] });
  });
  it("create_issue", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(201, { number: 9, html_url: "https://i/9" })));
    const transport = new GithubTransport();
    const result = await transport.invoke("create_issue", { repo: REPO, title: "bug" }, "tok", CTX);
    expect(result).toEqual({ external_id: "9", data: { number: "9", html_url: "https://i/9" } });
  });
  it("update_issue state=closed dekker close/reopen", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { number: 9, state: "closed", html_url: "https://i/9" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("update_issue", { repo: REPO, issue_number: "9", state: "closed" }, "tok", CTX);
    expect(result.data).toEqual({ number: "9", state: "closed", html_url: "https://i/9" });
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ state: "closed" });
  });
});

describe("F: workflow-kontroll (klasse B)", () => {
  it("rerun_workflow_run bruker rerun-failed-jobs når failed_only=true", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("rerun_workflow_run", { repo: REPO, run_id: "99", failed_only: true }, "tok", CTX);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/actions/runs/99/rerun-failed-jobs");
    expect(result.data).toEqual({ run_id: "99", action: "rerun-failed-jobs" });
  });
  it("cancel_workflow_run", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("cancel_workflow_run", { repo: REPO, run_id: "99" }, "tok", CTX);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/actions/runs/99/cancel");
    expect(result.data).toEqual({ run_id: "99", cancelled: true });
  });
});

describe("G: dispatch_workflow", () => {
  it("sender ref og inputs", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("dispatch_workflow", { repo: REPO, workflow_id: "ci.yml", ref: "main", inputs: { foo: "bar" } }, "tok", CTX);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ ref: "main", inputs: { foo: "bar" } });
    expect(result.data).toEqual({ workflow_id: "ci.yml", ref: "main", dispatched: true });
  });
});

describe("H: merge_pr (klasse D)", () => {
  it("sender merge_method og videresender expected_head_sha som GitHub sin egen sha-precondition", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { sha: "mergesha", merged: true, message: "Pull Request successfully merged" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("merge_pr", { repo: REPO, pr_number: "1", merge_method: "squash", expected_head_sha: "s" }, "tok", CTX);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("PUT");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ merge_method: "squash", sha: "s" });
    expect(result).toEqual({ external_id: "mergesha", data: { sha: "mergesha", merged: true, message: "Pull Request successfully merged" } });
  });
  it("default merge_method er 'merge' når ikke oppgitt", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, { sha: "m", merged: true, message: "ok" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await transport.invoke("merge_pr", { repo: REPO, pr_number: "1" }, "tok", CTX);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ merge_method: "merge" });
  });
  it("405 GENUIN not-mergeable (re-lest PR viser merged=false) gir fortsatt en klar, ikke-retry-bar GithubApiError - IKKE stille suksess", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(405, { message: "Pull Request is not mergeable" }))
      .mockResolvedValueOnce(jsonResponse(200, { merged: false, merge_commit_sha: null }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("merge_pr", { repo: REPO, pr_number: "1" }, "tok", CTX)).rejects.toMatchObject({ httpStatus: 405, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("405 PÅ RETRY av en FAKTISK allerede-merget PR gjenkjennes SOM SUKSESS via re-lesing - IKKE en feilrapportert idempotent operasjon (§12)", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(405, { message: "Pull Request is already merged" }))
      .mockResolvedValueOnce(jsonResponse(200, { merged: true, merge_commit_sha: "realmergesha" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("merge_pr", { repo: REPO, pr_number: "1" }, "tok", CTX);
    expect(result).toEqual({ external_id: "realmergesha", data: { sha: "realmergesha", merged: true, message: "already_merged_verified_on_reread" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("I: delete_branch (klasse D) - strukturelt vern mot beskyttede branches", () => {
  it("sletter en vanlig branch", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("delete_branch", { repo: REPO, branch: "jarvis/x" }, "tok", CTX);
    expect(result.data).toEqual({ branch: "jarvis/x", deleted: true });
  });
  it.each(["main", "master", "production"])("nekter å slette beskyttet branch '%s' UTEN noe HTTP-kall", async (branch) => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("delete_branch", { repo: REPO, branch }, "tok", CTX)).rejects.toThrow("github_protected_branch_refused");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("J: retry/backoff - KUN på bekreftede retry-bare statuser, respekterer Retry-After", () => {
  it("retryer 503 og lykkes på andre forsøk", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(503, { message: "temporarily unavailable" }))
      .mockResolvedValueOnce(jsonResponse(200, { full_name: REPO, description: null, updated_at: "d", default_branch: "main" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    const result = await transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((result.data as { full_name: string }).full_name).toBe(REPO);
  });
  it("retryer ALDRI 404 (ikke-retry-bar) - feiler umiddelbart på ett forsøk", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(404, { message: "Not Found" }));
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX)).rejects.toMatchObject({ httpStatus: 404, retryable: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("respekterer Retry-After-headeren på 429 fremfor gjettet backoff", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(jsonResponse(429, { message: "rate limited" }, { "retry-after": "2" }))
        .mockResolvedValueOnce(jsonResponse(200, { full_name: REPO, description: null, updated_at: "d", default_branch: "main" }));
      vi.stubGlobal("fetch", fetchMock);
      const transport = new GithubTransport();
      const promise = transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX);
      await vi.advanceTimersByTimeAsync(2000);
      await promise;
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("K: feilklassifisering - avkortet, sanert feilmelding, aldri rå kropp/headere", () => {
  it("GithubApiError inneholder GitHub sin message, avkortet, ikke stack/headere", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(422, { message: "Validation Failed" })));
    const transport = new GithubTransport();
    await expect(transport.invoke("create_issue", { repo: REPO, title: "x" }, "tok", CTX)).rejects.toBeInstanceOf(GithubApiError);
    await expect(transport.invoke("create_issue", { repo: REPO, title: "x" }, "tok", CTX)).rejects.toThrow(/Validation Failed/);
  });
  it("ikke-JSON feilkropp gir en trygg UNKNOWN/UNCLASSIFIED-klassifisering, kaster aldri på parsing", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response("<html>502</html>", { status: 502 })));
    const transport = new GithubTransport();
    await expect(transport.invoke("read_repo_meta", { repo: REPO }, "tok", CTX)).rejects.toThrow(/UNCLASSIFIED_ERROR_BODY/);
  });
});

describe("L: ukjent action / manglende parametre", () => {
  it("ukjent action kaster github_unsupported_action_<action>", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>());
    const transport = new GithubTransport();
    await expect(transport.invoke("delete_forever", { repo: REPO }, "tok", CTX)).rejects.toThrow("github_unsupported_action_delete_forever");
  });
  it("manglende repo kaster FØR noe HTTP-kall (skrive-/kontrollhandlinger; lesing faller til eierens repo, D-429)", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    const transport = new GithubTransport();
    await expect(transport.invoke("merge_pr", {}, "tok", CTX)).rejects.toThrow("github_missing_parameter:repo");
    await expect(transport.invoke("create_branch", {}, "tok", CTX)).rejects.toThrow("github_missing_parameter:repo");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("D-429: repo-oppløsning for lese-handlinger (modellen sender «jarvisbuild» eller utelater repo)", () => {
  it("manglende repo og repo uten eier faller til eierens konfigurerte repo - kun for lese-handlinger", () => {
    expect(resolveGithubRepo("list_pull_requests", undefined, undefined)).toBe(CANONICAL_GITHUB_REPO);
    expect(resolveGithubRepo("list_pull_requests", "jarvis-build", undefined)).toBe(CANONICAL_GITHUB_REPO);
    expect(resolveGithubRepo("list_pull_requests", " ", "acme/app")).toBe("acme/app");
    expect(resolveGithubRepo("get_commit", "andre", "acme/app")).toBe("acme/andre");
    expect(resolveGithubRepo("list_pull_requests", "annen-eier/repo", "acme/app")).toBe("annen-eier/repo");
    // ugyldig konfig ignoreres (standard brukes), og skriving får ALDRI standardrepo
    expect(resolveGithubRepo("list_branches", undefined, "ikke et repo")).toBe(CANONICAL_GITHUB_REPO);
    expect(() => resolveGithubRepo("merge_pr", undefined, undefined)).toThrow("github_missing_parameter:repo");
    expect(resolveGithubRepo("create_branch", "jarvisbuild", undefined)).toBe("jarvisbuild");
  });
  it("list_pull_requests med bare repo-navnet («jarvis-build») eller uten repo kaller GitHub på riktig repo-URL", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(200, []));
    vi.stubGlobal("fetch", fetchMock);
    await new GithubTransport().invoke("list_pull_requests", { repo: "jarvis-build" }, "tok", CTX);
    await new GithubTransport().invoke("list_pull_requests", {}, "tok", CTX);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/repos/${CANONICAL_GITHUB_REPO}/pulls?state=open`);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(`/repos/${CANONICAL_GITHUB_REPO}/pulls?state=open`);
  });
});
