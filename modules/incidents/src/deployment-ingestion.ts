import type { IdentityContext } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import type { DeploymentService } from "./deployments.ts";
import type { Deployment, DeploymentStatus } from "./types.ts";

/**
 * D-105 (UA-5 kriterium 1 host-fix): lukker det siste live-gapet closeout-
 * audit fant - `DeploymentService.recordDeployment()` hadde INGEN
 * produksjons-callsite (kun brukt i tester). Denne filen ER den callsiten:
 * en tynn orkestrator som gjør AKKURAT det `DeploymentService`-kommentaren
 * allerede lovet - henter et Actions-workflow-kjøring via DEN EKSISTERENDE
 * `github.get_workflow_run`-ToolGateway-veien, normaliserer DETERMINISTISK
 * til `RecordDeploymentInput`, og persisterer idempotent. INGEN egen HTTP/
 * Octokit-klient (D-41: gjenbruker den fullverdige eksisterende GitHub-
 * connectoren via `ToolGateway`, bygger ALDRI en parallell klient - D-64:
 * GitHub forblir EXTERNAL_CANONICAL, Jarvis kanonicaliserer KUN den
 * observerte tilstanden internt via `deployments`-tabellen, INGEN ny core-
 * avhengighet).
 */

const KNOWN_STATUSES: ReadonlySet<string> = new Set(["success", "failure", "in_progress", "cancelled"]);

export interface IngestGithubDeploymentInput {
  repo: string;
  workflow_run_id: string;
}

export interface GithubDeploymentProvenance {
  workflow_run_id: string;
  workflow_name: string;
  workflow_html_url: string;
  provider_status: string;
  provider_conclusion: string;
  head_branch: string;
  /** Bevisst valgfri - `get_commit`-berikelsen er "når det gir nødvendig provenance", ALDRI påkrevd for selve canonicaliseringen (head_sha fra workflow-run er allerede den kanoniske commit_sha-en). */
  commit_message?: string;
  commit_author?: string;
  commit_html_url?: string;
}

export type IngestGithubDeploymentOutcome =
  | { status: "ingested"; deployment: Deployment; created: boolean; provenance: GithubDeploymentProvenance }
  | { status: "provider_unavailable"; reason: string }
  | { status: "invalid_provider_response"; reason: string };

/**
 * Deterministisk status-normalisering (INGEN gjetning - Q-26): GitHub sin
 * `status` er `queued`/`in_progress`/`completed`; `conclusion` (kun satt når
 * `completed`) er `success`/`failure`/`cancelled`/`timed_out`/`neutral`/
 * `action_required`/`stale`/`skipped`. Alt som IKKE er eksplisitt `success`
 * eller `cancelled` ved fullføring mappes KONSERVATIVT til `failure` - ALDRI
 * en stille/antatt `success` for en tvetydig/ukjent provider-conclusion.
 */
function toDeploymentStatus(providerStatus: string, providerConclusion: string): DeploymentStatus {
  if (providerStatus !== "completed") return "in_progress";
  if (providerConclusion === "success") return "success";
  if (providerConclusion === "cancelled") return "cancelled";
  return "failure";
}

interface WorkflowRunData {
  id?: unknown; name?: unknown; status?: unknown; conclusion?: unknown;
  head_sha?: unknown; head_branch?: unknown; html_url?: unknown; created_at?: unknown;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * D-105 (UA-5 kriterium 1 host-fix): henter ÉN Actions-workflow-kjøring via
 * `ToolGateway.execute()` (ALDRI et direkte HTTP/Octokit-kall), validerer
 * providerresultatet STRUKTURELT (manglende/tomt påkrevd felt -> eksplisitt
 * `invalid_provider_response`, ALDRI en fabrikkert/gjettet verdi), og
 * normaliserer til canonical `RecordDeploymentInput`. `head_sha` fra selve
 * workflow-kjøringen er den kanoniske `commit_sha`-en (§A3 i byggeordren);
 * `github.get_commit` kalles i tillegg som BEST-EFFORT-berikelse (feil der
 * er ALDRI fatalt for selve ingestion - manglende ekstra provenance er ikke
 * det samme som en manglende deployment).
 */
export async function ingestGithubDeployment(
  deps: { gateway: ToolGateway; deployments: DeploymentService },
  identity: IdentityContext,
  input: IngestGithubDeploymentInput
): Promise<IngestGithubDeploymentOutcome> {
  const runResult = await deps.gateway.execute({
    identity,
    tool_id: "github",
    action: "get_workflow_run",
    parameters: { repo: input.repo, run_id: input.workflow_run_id }
  });
  if (!runResult.ok) {
    return { status: "provider_unavailable", reason: runResult.reason };
  }
  const run = runResult.data as WorkflowRunData | undefined;
  if (
    !run ||
    !isNonEmptyString(run.head_sha) ||
    !isNonEmptyString(run.status) ||
    !isNonEmptyString(run.created_at) ||
    Number.isNaN(Date.parse(run.created_at))
  ) {
    // D-105 host-fix: ALDRI Date.now() her - et manglende/ugyldig provider-
    // tidsstempel er en EKSPLISITT feil, ikke noe "godt nok"-fallback kan
    // dekke over (byggeordrens §A: "IKKE bruk Date.now() og kall det
    // provider truth").
    return { status: "invalid_provider_response", reason: "missing_or_invalid_required_fields" };
  }
  const providerConclusion = typeof run.conclusion === "string" ? run.conclusion : "";
  const status = toDeploymentStatus(run.status, providerConclusion);

  const provenance: GithubDeploymentProvenance = {
    workflow_run_id: input.workflow_run_id,
    workflow_name: typeof run.name === "string" ? run.name : "",
    workflow_html_url: typeof run.html_url === "string" ? run.html_url : "",
    provider_status: run.status,
    provider_conclusion: providerConclusion,
    head_branch: typeof run.head_branch === "string" ? run.head_branch : ""
  };

  // Best-effort commit-berikelse - se filkommentaren over. `get_commit` sin
  // `ref`-parameter aksepterer en sha direkte (samme mønster som github-
  // transportens EKSISTERENDE `get_branch`/`get_commit`-bruk andre steder).
  const commitResult = await deps.gateway.execute({
    identity, tool_id: "github", action: "get_commit",
    parameters: { repo: input.repo, ref: run.head_sha }
  });
  if (commitResult.ok && commitResult.data) {
    const commit = commitResult.data as { message?: unknown; author?: unknown; html_url?: unknown };
    if (typeof commit.message === "string") provenance.commit_message = commit.message;
    if (typeof commit.author === "string") provenance.commit_author = commit.author;
    if (typeof commit.html_url === "string") provenance.commit_html_url = commit.html_url;
  }

  const { deployment, created } = await deps.deployments.recordDeployment(identity.tenant_id, {
    source: "github_actions",
    repo: input.repo,
    commit_sha: run.head_sha,
    ...(provenance.head_branch ? { ref: provenance.head_branch } : {}),
    workflow_run_id: input.workflow_run_id,
    status,
    deployed_at: run.created_at
  });

  return { status: "ingested", deployment, created, provenance };
}

/** Eksponert for tester/typechecking av det lukkede statussettet - ikke brukt i selve normaliseringslogikken. */
export function isKnownDeploymentStatus(value: string): value is DeploymentStatus {
  return KNOWN_STATUSES.has(value);
}
