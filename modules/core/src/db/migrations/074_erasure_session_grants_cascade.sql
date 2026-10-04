-- D-395 (JARVIS-030): sletting av en sesjon (samtale-/person-/tenant-erasure, `DELETE FROM sessions`) feilet med FK-brudd for HVER sesjon som noen gang
-- har fatt et enhets-grant (hver stemme-/mobil-/desktop-autorisasjon siden D-131), og hele erasure-transaksjonen rullet tilbake. Grantet er avledet
-- autorisasjonstilstand for sesjonen og skal forsvinne sammen med den. Referanseaksjonen kjorer med eierens rettigheter, sa runtime-rollen far
-- fortsatt IKKE DELETE pa `session_grants` (053: kompromittert runtime kan ikke slette grants direkte).
ALTER TABLE session_grants DROP CONSTRAINT session_grants_tenant_session_fkey;
ALTER TABLE session_grants
  ADD CONSTRAINT session_grants_tenant_session_fkey FOREIGN KEY (tenant_id, session_id) REFERENCES sessions (tenant_id, session_id) ON DELETE CASCADE;
