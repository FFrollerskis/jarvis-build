-- Q-34 P2-oppfølging (uavhengig arkitektkontroll av PR #82, EXACT_HEAD_SHA
-- 91b0168): en mislykket postcondition-verifisering ble lagret som
-- status='succeeded' i tool_executions - identisk med en FAKTISK bekreftet
-- suksess. En retry med SAMME idempotency_key traff derfor dedupe-grenen i
-- ToolGateway.execute() og fikk et FALSKT ok:true, UTEN noen ny lesing, og
-- kunne dermed skjule at handlingen fortsatt ikke er bekreftet gjennomført.
--
-- Ny status 'unverified' gjør utfallet REPLAY-BART SANT: en retry skal se
-- NØYAKTIG det samme, sanne (ikke-suksessfulle) resultatet den opprinnelige
-- kalleren fikk - aldri en tilfeldig omgjøring til suksess, og aldri en ny
-- mutasjon. `postcondition_reason` lagrer den EKSAKTE grunnen
-- (`postcondition_unverified:readback_failed`/`:target_missing`/
-- `:predicate_error`/`postcondition_mismatch`) slik at en replay kan
-- returnere IDENTISK avslag, ikke en generisk erstatning.
--
-- `before_state`/`after_state` (011_runrate_evidence.sql) er UENDRET -
-- mutasjonskallet lyktes strukturelt selv når verifiseringen ikke gjorde
-- det, og recovery-tooling må fortsatt se before_state.

ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check
  CHECK (status IN ('succeeded', 'failed', 'unverified'));

ALTER TABLE tool_executions ADD COLUMN postcondition_reason text;
