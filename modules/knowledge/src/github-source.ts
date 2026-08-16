import { createHash } from "node:crypto";
import type { IdentityContext, JsonValue } from "@jarvis/contracts";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { KnowledgeSourceError, type KnowledgeListResult, type KnowledgeRecord, type KnowledgeSource, type SourceErrorClass } from "./source.ts";

/**
 * UA-2 P1A §15: mapper en ToolGateway `reason`-streng til en typet
 * `SourceErrorClass`. Konservativ default (`SOURCE_UNAVAILABLE`, retryable)
 * for ukjente årsaker - en transient feil skal ALDRI klassifiseres som noe
 * som ser mer permanent/skummelt ut enn den er.
 */
function classifyToolFailure(reason: string): SourceErrorClass {
  if (reason === "rate_limited") return "RATE_LIMIT";
  if (/auth_failed|401|403/.test(reason)) return "AUTH";
  if (/not_found|404/.test(reason)) return "NOT_FOUND";
  return "SOURCE_UNAVAILABLE";
}

/**
 * UA-2 P0 §3: GitHub som kunnskapskilde. Går gjennom EKSISTERENDE ToolGateway
 * (samme mønster som `daily-brief.ts` sine kilder) - policy/rate-limit/audit/
 * credential-håndtering gjenbrukes, ingen ny autentiseringsvei. Ingen nye
 * OAuth-scopes: samme PAT som `read_issues` fra før.
 *
 * P0-omfang: repo-metadata + issues. Repo-FIL-innhold er IKKE bygget her
 * (§14/§3 - dokumentert som neste skive; eksisterende GithubTransport støtter
 * ikke fil-lesing uten en større connector-utvidelse).
 */
export class GithubKnowledgeSource implements KnowledgeSource {
  readonly source_type = "github";
  readonly source_instance_id: string;

  constructor(
    private readonly toolGateway: ToolGateway,
    private readonly identity: IdentityContext,
    private readonly repo: string
  ) {
    this.source_instance_id = `github:${repo}`;
  }

  /**
   * UA-2 P1A §15 (fix av latent bug): tidligere ble en feilet
   * `read_repo_meta`/`read_issues` bare stille hoppet over, slik at
   * `KnowledgeSyncService.sync()` (som tombstoner alt IKKE sett i en
   * VELLYKKET listing) kunne feiltolke en forbigående ToolGateway-feil
   * (rate-limit, auth-blip) som "alle issues slettet". Nå kaster begge et
   * `KnowledgeSourceError` ved `!ok` - hele listingen feiler synlig og
   * EKSPLISITT i stedet for å late som den var fullstendig.
   */
  async list(): Promise<KnowledgeListResult> {
    const records: KnowledgeRecord[] = [];

    const metaResult = await this.toolGateway.execute({
      identity: this.identity, tool_id: "github", action: "read_repo_meta", parameters: { repo: this.repo }
    });
    if (!metaResult.ok) {
      throw new KnowledgeSourceError(classifyToolFailure(metaResult.reason), `github_read_repo_meta_failed: ${metaResult.reason}`);
    }
    if (metaResult.data) {
      const meta = metaResult.data as { full_name: string; description: string; updated_at: string; default_branch: string };
      const content = `${meta.full_name}\n\n${meta.description}`;
      records.push({
        source_type: this.source_type,
        source_instance_id: this.source_instance_id,
        external_id: `repo:${this.repo}`,
        canonical_uri: `https://github.com/${this.repo}`,
        title: meta.full_name,
        content,
        content_type: "text/plain",
        content_hash: createHash("sha256").update(content).digest("hex"),
        modified_at: meta.updated_at,
        metadata: { kind: "repo_meta", default_branch: meta.default_branch }
      });
    }

    const issuesResult = await this.toolGateway.execute({
      identity: this.identity, tool_id: "github", action: "read_issues", parameters: { repo: this.repo }
    });
    if (!issuesResult.ok) {
      throw new KnowledgeSourceError(classifyToolFailure(issuesResult.reason), `github_read_issues_failed: ${issuesResult.reason}`);
    }
    if (issuesResult.data) {
      const { issues } = issuesResult.data as {
        issues: Array<{ id: string; title: string; at: string; is_pr: string; ci_failing: string }>;
      };
      for (const issue of issues) {
        const content = issue.title;
        records.push({
          source_type: this.source_type,
          source_instance_id: this.source_instance_id,
          external_id: `issue:${issue.id}`,
          canonical_uri: `https://github.com/${this.repo}/issues/${issue.id}`,
          title: issue.title,
          content,
          content_type: "text/plain",
          content_hash: createHash("sha256").update(content).digest("hex"),
          modified_at: issue.at,
          metadata: { kind: "issue", is_pr: issue.is_pr === "true" } as Record<string, JsonValue>
        });
      }
    }

    return { records, skipped: [] };
  }
}
