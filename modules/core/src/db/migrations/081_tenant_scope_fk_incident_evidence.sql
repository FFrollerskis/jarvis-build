-- Q-44 / D-435: koblingstabellen `incident_diagnosis_evidence` hadde INGEN tenant_id (037) og falt dermed utenfor 078–080 (vakten sjekket bare
-- barn med tenant_id). RLS kontrollerte bare diagnosis_id, så tenant A kunne parre sin egen diagnose med tenant B sin evidence_id (FK-kontrollen
-- går utenom RLS). Nå: egen tenant_id (backfylt fra diagnosen), komposittnøkler mot begge foreldre, og en RLS-policy på tenant_id.
ALTER TABLE incident_diagnosis_evidence ADD COLUMN tenant_id text;
UPDATE incident_diagnosis_evidence de SET tenant_id = d.tenant_id FROM incident_diagnoses d WHERE d.diagnosis_id = de.diagnosis_id;
ALTER TABLE incident_diagnosis_evidence ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE incident_diagnosis_evidence ADD CONSTRAINT incident_diagnosis_evidence_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants (tenant_id);
-- Rader der beviset tilhører en annen tenant enn diagnosen avvises av komposittnøkkelen under (migrasjonen feiler høyt; rett radene, fjern ikke nøkkelen).
SELECT jarvis_scope_fk('incident_diagnosis_evidence', 'diagnosis_id', 'incident_diagnoses', 'diagnosis_id');
SELECT jarvis_scope_fk('incident_diagnosis_evidence', 'evidence_id', 'incident_evidence', 'evidence_id');
DROP POLICY incident_diagnosis_evidence_tenant ON incident_diagnosis_evidence;
CREATE POLICY incident_diagnosis_evidence_tenant ON incident_diagnosis_evidence
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
