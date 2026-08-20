import type { IdentityContext, JobContract, JsonValue, TrustLevel } from "@jarvis/contracts";

/**
 * Strukturelt (duck-typed) grensesnitt mot `ToolGateway.execute()` - IKKE en
 * import av `@jarvis/tool-gateway` sjøl. `@jarvis/tool-gateway` avhenger
 * allerede av `@jarvis/memory`, som har `@jarvis/tasks` som devDependency
 * (for egne tester) - en direkte pakkeavhengighet HIT ville derfor lukket en
 * sirkulær workspace-graf (tasks→tool-gateway→memory→(dev)→tasks). Formen
 * under er en bevisst, håndskrevet ("hjemme rulla") strukturell kopi av den
 * ekte `ToolGateway.execute()`-signaturen (se modules/tool-gateway/src/
 * gateway.ts) - enhver ekte `ToolGateway`-instans tilfredsstiller den
 * uendret, siden TypeScript strukturell typing ikke bryr seg om pakke-
 * opprinnelse. Composition-root (apps/api) kobler en ekte `ToolGateway` inn
 * her uten cast.
 */
export type ToolExecutionResult =
  | { ok: true; external_id?: string; data?: JsonValue; output_trust: TrustLevel; deduplicated: boolean }
  | { ok: false; reason: string };

export interface PrPublishingGateway {
  execute(request: {
    identity: IdentityContext;
    tool_id: string;
    action: string;
    parameters: Record<string, JsonValue>;
    idempotency_key?: string;
    jobContract?: JobContract;
  }): Promise<ToolExecutionResult>;
}

/**
 * UA-5 Tested Fix Orchestrator v1 (D-95): glue mellom en fullført kodejobb
 * (ekte sandbox/branch/test/commit/push, se coding.ts) og GitHub-siden av
 * tested-fix-livssyklusen (D-94's `github.create_pr`, klasse C, via
 * ToolGateway.execute() - INGEN ny transport, INGEN ny risikoklasse).
 *
 * Eksplisitt IKKE her: diagnose/fiks-generering (fortsatt CodingAgentAdapter
 * sitt ansvar - uendret placeholder/stub), og ALDRI merge (klasse D,
 * `github.merge_pr` forblir en separat, eier-autorisert handling denne
 * modulen aldri kaller).
 */
export interface PrPublishResult {
  status: "created" | "found_existing" | "already_published" | "skipped_not_allowed" | "skipped_unparseable_repo" | "failed";
  repo?: string;
  pr_number?: string;
  pr_url?: string;
  reason?: string;
}

/**
 * `owner/repo` fra en git-klone-URL. Returnerer null (aldri kaster) for
 * URL-er som ikke gjenkjennes som GitHub - PR-opprettelse hoppes da trygt
 * over; det pusher jobb-branchen har allerede lyktes uavhengig av dette.
 */
export function parseGithubRepoSlug(repoUrl: string): string | null {
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/i.exec(repoUrl);
  if (https) return `${https[1]}/${https[2]}`;
  const ssh = /^git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/i.exec(repoUrl);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  return null;
}

export async function publishPullRequestForCodingJob(params: {
  gateway: PrPublishingGateway;
  identity: IdentityContext;
  jobContract: JobContract;
  repoUrl: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}): Promise<PrPublishResult> {
  // D-41/D-64: ingen ny blanket-godkjenningssperre - respekterer KUN
  // jobbkontraktens EKSISTERENDE allowed_tools-mekanisme (samme mandat
  // ToolGateway.execute() selv håndhever via jobContract). Autorisasjon
  // sjekkes FØR repo-parsing: mangler mandatet, spiller det ingen rolle
  // om repo-URL-en i det hele tatt er gjenkjennelig.
  if (!params.jobContract.allowed_tools.includes("github")) {
    return { status: "skipped_not_allowed", reason: "github_not_in_job_contract_allowed_tools" };
  }
  const repo = parseGithubRepoSlug(params.repoUrl);
  if (!repo) {
    return { status: "skipped_unparseable_repo", reason: "repo_url_not_recognized_as_github" };
  }

  const result = await params.gateway.execute({
    identity: params.identity,
    tool_id: "github",
    action: "create_pr",
    parameters: { repo, branch: params.branch, title: params.title, base: params.base, body: params.body },
    // Deterministisk per jobb: en gjenopptatt jobb (krasj/retry etter push)
    // oppretter aldri en ny/duplikat PR - gjenbruker eksisterende
    // tool_executions-dedupe (D-94-mønster), ingen ny idempotens-mekanisme.
    idempotency_key: `coding-job-pr:${params.jobContract.task_id}`,
    jobContract: params.jobContract
  });

  if (!result.ok) {
    return { status: "failed", repo, reason: result.reason };
  }
  if (result.deduplicated) {
    return {
      status: "already_published",
      repo,
      ...(result.external_id !== undefined ? { pr_number: result.external_id } : {})
    };
  }
  const data = result.data as { number?: string; html_url?: string; created?: boolean } | undefined;
  return {
    status: data?.created === false ? "found_existing" : "created",
    repo,
    ...(data?.number !== undefined ? { pr_number: data.number } : {}),
    ...(data?.html_url !== undefined ? { pr_url: data.html_url } : {})
  };
}
