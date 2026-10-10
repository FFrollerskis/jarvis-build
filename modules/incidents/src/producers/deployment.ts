import type pg from "pg";
import type { IdentityContext } from "@jarvis/contracts";
import { withTenantTransaction } from "@jarvis/core";
import type { ToolGateway } from "@jarvis/tool-gateway";
import { ingestGithubDeployment } from "../deployment-ingestion.ts";
import type { DeploymentService } from "../deployments.ts";
import type { IncidentFact } from "../types.ts";
import { subjectOf, type IncidentProducer, type ProducerClearing } from "./types.ts";

/**
 * WP-E1 (JARVIS-068): en FEILET utrulling blir en hendelse. Kilden er `deployments` (D-104/D-105, fylt av `ingestGithubDeployment`), og kun utrullinger på de KONFIGURERTE grenene
 * (`refs`, standard `main`) teller - JARVIS-068 pekte på at `deployment-ingestion` regner CI på enhver gren som en utrulling; en feilet CI på en feature-gren er ikke en produksjonshendelse.
 *
 * Fingeravtrykket er `repo@gren` (ikke commit): en ny feilet utrulling på samme gren oppdaterer samme hendelse. Løsning kun når den NYESTE avgjorte utrullingen (success/failure) for
 * repo@gren er `success`. Åpning gjelder kun utrullinger siste `lookbackHours` (en gammel feil åpner ikke en hendelse første gang produsenten slås på).
 *
 * Valgfri INNHENTING (`ingest`): for eksplisitt konfigurerte repoer leses de siste fullførte Actions-kjøringene via `ToolGateway` (`github.list_workflow_runs`, klasse A) og de som ikke er
 * registrert ennå, ingestes med den EKSISTERENDE `ingestGithubDeployment` (idempotent). Uten `ingest` leser produsenten bare det som allerede er ingestet.
 */
export interface DeploymentProducerDeps {
  pool: pg.Pool;
  refs: readonly string[];
  lookbackHours?: number;
  ingest?: { gateway: Pick<ToolGateway, "execute">; deployments: DeploymentService; identity: IdentityContext; repos: readonly string[]; maxPerTarget?: number };
}

interface DeploymentRow {
  deployment_id: string;
  repo: string;
  ref: string;
  commit_sha: string;
  source: string;
  status: "success" | "failure";
  deployed_at: Date | string;
}

async function ingestRecentRuns(ingest: NonNullable<DeploymentProducerDeps["ingest"]>, tenantId: string, refs: readonly string[], pool: pg.Pool): Promise<void> {
  const limit = ingest.maxPerTarget ?? 3;
  for (const repo of ingest.repos) {
    for (const ref of refs) {
      const listed = await ingest.gateway.execute({ identity: ingest.identity, tool_id: "github", action: "list_workflow_runs", parameters: { repo, branch: ref } });
      if (!listed.ok) throw new Error(`deployment_ingest_unavailable:${listed.reason.slice(0, 80)}`);
      const runs = (listed.data as { workflow_runs?: unknown } | undefined)?.workflow_runs;
      if (!Array.isArray(runs)) continue;
      const candidates = runs
        .filter((r): r is { id: string; status: string; head_branch?: string } => typeof r === "object" && r !== null && typeof (r as { id?: unknown }).id === "string" && /^\d{1,20}$/.test((r as { id: string }).id) && (r as { status?: unknown }).status === "completed")
        .filter((r) => r.head_branch === undefined || r.head_branch === ref)
        .slice(0, limit);
      for (const run of candidates) {
        const known = await withTenantTransaction(pool, tenantId, (client) =>
          client.query(`SELECT 1 FROM deployments WHERE tenant_id = $1 AND source = 'github_actions' AND repo = $2 AND workflow_run_id = $3`, [tenantId, repo, run.id])
        );
        if (known.rowCount) continue;
        await ingestGithubDeployment({ gateway: ingest.gateway as ToolGateway, deployments: ingest.deployments }, ingest.identity, { repo, workflow_run_id: run.id });
      }
    }
  }
}

export function deploymentProducer(deps: DeploymentProducerDeps): IncidentProducer {
  const lookback = deps.lookbackHours ?? 48;
  return {
    name: "deployment",
    async observe(ctx, active) {
      if (deps.refs.length === 0) return { present: [], cleared: [], skipped: "no_deploy_refs_configured" };
      if (deps.ingest && deps.ingest.repos.length > 0) await ingestRecentRuns(deps.ingest, ctx.tenantId, deps.refs, deps.pool);
      const latest = await withTenantTransaction(deps.pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT DISTINCT ON (repo, ref) deployment_id, repo, ref, commit_sha, source, status, deployed_at
             FROM deployments WHERE tenant_id = $1 AND ref = ANY($2::text[]) AND status IN ('success', 'failure')
            ORDER BY repo, ref, deployed_at DESC`,
          [ctx.tenantId, [...deps.refs]]
        );
        return rows as DeploymentRow[];
      });
      const present: IncidentFact[] = [];
      const presentKeys = new Set<string>();
      const cutoff = ctx.now.getTime() - lookback * 3_600_000;
      for (const d of latest) {
        if (d.status !== "failure" || new Date(d.deployed_at).getTime() < cutoff) continue;
        const subject = `${d.repo}@${d.ref}`;
        presentKeys.add(subject);
        present.push({
          source_kind: "deployment", subject, title: `Utrulling feilet: ${d.repo} (${d.ref})`, severity: "high", observed_at: new Date(d.deployed_at).toISOString(),
          evidence: {
            source_type: "deployment", source_ref: d.deployment_id,
            summary: `${d.source}-utrulling av ${d.commit_sha.slice(0, 12)} på ${d.ref} fikk status failure (${new Date(d.deployed_at).toISOString()})`
          }
        });
      }
      const bySubject = new Map(latest.map((d) => [`${d.repo}@${d.ref}`, d]));
      const cleared: ProducerClearing[] = [];
      for (const incident of active) {
        const subject = subjectOf("deployment", incident.dedupe_key);
        if (subject === null || presentKeys.has(subject)) continue;
        const d = bySubject.get(subject);
        if (!d || d.status !== "success") continue; // nyeste avgjorte utrulling må være en suksess
        cleared.push({
          subject,
          check: {
            source_type: "deployment", source_ref: d.deployment_id, summary: `${d.repo} (${d.ref}): nyeste utrulling ${d.commit_sha.slice(0, 12)} lyktes (${new Date(d.deployed_at).toISOString()})`,
            observed_at: new Date(d.deployed_at).toISOString(), verified_by: "source_recheck", basis: `deployments: nyeste avgjorte utrulling for ${subject} er ${d.deployment_id} (success)`
          }
        });
      }
      return { present, cleared };
    }
  };
}
