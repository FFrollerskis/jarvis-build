import type { MemorySpace } from "@jarvis/contracts";
import type { DeploymentService } from "./deployments.ts";
import type { IncidentService } from "./service.ts";
import type { CorrelationResult, IncidentEvidence } from "./types.ts";

/**
 * D-104 Part B: 100% deterministisk korrelasjon - INGEN LLM-gjetning
 * noensinne etablert som "korrelert sannhet". Svarer på "hva skjedde rett
 * FØR hendelsen brøt ut" ved å slå opp den nyeste `deployments`-raden for
 * repoet FØR det tidligste observerte beviset - en ren tidsvindu-spørring,
 * aldri en heuristisk/sannsynlighetsbasert gjetning.
 *
 * `evidence.status` forfremmes til `VERIFIED` KUN når en `deployment`-typet
 * bevisrad faktisk matcher (samme `deployment_id` som `suspect_deployment`,
 * bevist via `source_ref`) - ALDRI en stille, ubegrunnet forfremmelse av
 * andre bevistyper. WP-E1: forfremmelsen går gjennom `verifyEvidence()` med
 * `correlation_deployment_match` + lagret grunnlag (sannhetstype-regimet). Kontradiksjoner (`contradicts_evidence_id`-kjeder)
 * returneres EKSPLISITT, ALDRI filtrert bort.
 */
export async function correlateIncident(
  incidents: IncidentService,
  deployments: DeploymentService,
  tenantId: string,
  memorySpace: MemorySpace,
  incidentId: string,
  repo: string
): Promise<CorrelationResult> {
  const incident = await incidents.getIncident(tenantId, memorySpace, incidentId);
  if (!incident) {
    throw new Error("incident_not_found");
  }
  const evidence = await incidents.listEvidence(tenantId, memorySpace, incidentId);
  const contradictions = evidence.filter((e) => e.contradicts_evidence_id !== null);

  const active_deployment = await deployments.findActiveDeployment(tenantId, repo);

  let suspect_deployment: CorrelationResult["suspect_deployment"] = null;
  if (evidence.length > 0) {
    const earliestObservedAt = evidence.reduce(
      (earliest, e) => (e.observed_at < earliest ? e.observed_at : earliest),
      evidence[0]!.observed_at
    );
    suspect_deployment = await deployments.findSuspectDeployment(tenantId, repo, earliestObservedAt);
  }

  if (suspect_deployment) {
    // WP-E1 (JARVIS-068): forfremmelsen er en DETERMINISTISK kontroll (deployment-raden finnes og matcher), og grunnlaget lagres med statusen. Modellskrevet bevis forfremmes aldri.
    const basis = `deployments:${suspect_deployment.deployment_id} (commit ${suspect_deployment.commit_sha.slice(0, 12)}, ${suspect_deployment.status}) er siste utrulling før første observasjon`;
    const matchingDeploymentEvidence = evidence.filter(
      (e): e is IncidentEvidence =>
        e.source_type === "deployment" && e.source_ref === suspect_deployment!.deployment_id && e.status !== "VERIFIED" && e.asserted_by !== "model"
    );
    for (const e of matchingDeploymentEvidence) {
      await incidents.verifyEvidence(tenantId, memorySpace, e.evidence_id, { verified_by: "correlation_deployment_match", basis });
    }
  }

  const refreshedEvidence = await incidents.listEvidence(tenantId, memorySpace, incidentId);
  return { incident, evidence: refreshedEvidence, contradictions, suspect_deployment, active_deployment };
}
