import type { RowFactory } from "@jarvis/core/testing";

/**
 * WP-MC8a K4: tabeller der policyen slår opp en FORELDERRAD (RLS leser en annen tabell), så en automatisk syntetisert rad ikke er synlig uten at forelderen finnes.
 * Fabrikken oppretter forelderen (som admin, samme tenant og `seq`) og returnerer den automatiske barneraden. Kjører mot fixture-databasen (uten constraints).
 */
export const iso: Record<string, RowFactory> = {
  // policy: tenant_id = ctx AND diagnosis_id IN (SELECT diagnosis_id FROM incident_diagnoses WHERE tenant_id = ctx)
  incident_diagnosis_evidence: async (a) => {
    await a.seedParent("incident_diagnoses", a.auto("incident_diagnoses"));
    return a.auto("incident_diagnosis_evidence");
  }
};
