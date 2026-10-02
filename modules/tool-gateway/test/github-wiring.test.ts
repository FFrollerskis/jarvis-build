import { describe, expect, it } from "vitest";
import { firstWaveTools } from "../src/integrations.ts";

/**
 * UA-5 GitHub Developer Control Plane v1: D-41-matrisen (risikoklasse per
 * handling) er selve sikkerhetskontrakten - denne testen beviser at
 * `firstWaveTools()` faktisk registrerer den tilsiktede klassen for HVER
 * github-handling, at kritiske/destruktive handlinger har preflight_action
 * (target-re-read/recovery-grunnlag), og at alle deler samme `credential_ref`
 * (ingen ny, parallell credential-type innført).
 */
function githubTool(action: string) {
  const tool = firstWaveTools({}).find((t) => t.tool_id === "github" && t.action === action);
  if (!tool) throw new Error(`github tool not registered: ${action}`);
  return tool;
}

describe("D-41 risikoklasse-matrise for github.*", () => {
  const expectedClasses: Record<string, string> = {
    read_repo_meta: "A", read_issues: "A", list_branches: "A", get_branch: "A", get_commit: "A",
    list_pull_requests: "A", get_pull_request: "A", list_workflow_runs: "A", get_workflow_run: "A", list_workflow_jobs: "A",
    create_branch: "B", update_pr: "B", comment_on_issue: "C", set_labels: "B", request_reviewers: "B",
    create_issue: "B", update_issue: "B", rerun_workflow_run: "C", cancel_workflow_run: "C",
    create_pr: "C", dispatch_workflow: "C",
    merge_pr: "D", delete_branch: "D"
  };
  for (const [action, expected] of Object.entries(expectedClasses)) {
    it(`${action} er klasse ${expected}`, () => {
      expect(githubTool(action).capability_class).toBe(expected);
    });
  }
});

describe("Kritiske/destruktive handlinger har preflight (target-re-read + before/after-evidens)", () => {
  it("merge_pr sin preflight_action er get_pull_request (leser mergeable_state RETT FØR merge)", () => {
    expect(githubTool("merge_pr").preflight_action).toBe("get_pull_request");
  });
  it("delete_branch sin preflight_action er get_branch (fanger sha til recovery-tekst FØR sletting)", () => {
    expect(githubTool("delete_branch").preflight_action).toBe("get_branch");
  });
});

describe("Samme credential_ref for ALLE github-handlinger (ingen ny, parallell credential-type)", () => {
  const allActions = Object.keys({
    read_repo_meta: 0, read_issues: 0, list_branches: 0, get_branch: 0, get_commit: 0,
    list_pull_requests: 0, get_pull_request: 0, list_workflow_runs: 0, get_workflow_run: 0, list_workflow_jobs: 0,
    create_branch: 0, update_pr: 0, comment_on_issue: 0, set_labels: 0, request_reviewers: 0,
    create_issue: 0, update_issue: 0, rerun_workflow_run: 0, cancel_workflow_run: 0,
    create_pr: 0, dispatch_workflow: 0, merge_pr: 0, delete_branch: 0
  });
  for (const action of allActions) {
    it(`${action} bruker JARVIS_GITHUB_TOKEN`, () => {
      expect(githubTool(action).credential_ref).toBe("JARVIS_GITHUB_TOKEN");
    });
  }
});

describe("Reversibilitet/rollback er eksplisitt dokumentert for hver skriv-/mutasjonshandling", () => {
  const writeActions = ["create_branch", "update_pr", "comment_on_issue", "set_labels", "request_reviewers",
    "create_issue", "update_issue", "rerun_workflow_run", "cancel_workflow_run", "create_pr", "dispatch_workflow", "merge_pr", "delete_branch"];
  for (const action of writeActions) {
    it(`${action} har en ikke-tom rollback_procedure-tekst`, () => {
      expect(githubTool(action).rollback_procedure.length).toBeGreaterThan(0);
    });
  }
  it("merge_pr er eksplisitt IKKE reversible=true (kun revert-commit, ingen ekte unmerge)", () => {
    expect(githubTool("merge_pr").reversible).toBe(false);
  });
});

describe("Eksisterende posisjons-indekserte tester (fase7-tools.test.ts) er urørt", () => {
  it("firstWaveTools({}) sin lengde har KUN vokst ved tillegg på slutten - create_pr (indeks 1) er fortsatt github:create_pr", () => {
    const tools = firstWaveTools({});
    expect(tools[1]?.tool_id).toBe("github");
    expect(tools[1]?.action).toBe("create_pr");
    expect(tools[1]?.capability_class).toBe("C");
  });
});
