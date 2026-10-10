-- WP-D2 (JARVIS-045, mandat D-450): utfall og forklaring for open loops - grunnlaget for confidence fra flere signaler og en kalibreringsrapport (forutsagt mot utfall).
-- Additiv migrasjon på 020_business_open_loops.sql - ingen eksisterende kolonne endres.
--
--  1. `resolution_outcome`: HVA som skjedde da loopen ble lukket - 'acted' (eieren/operatøren handlet på den), 'dismissed' (avvist som irrelevant) eller 'condition_cleared'
--     (vilkåret forsvant av seg selv; satt av sveipet). NULL på en lukket loop = lukket UTEN utfall (umerket - kalibreringen teller den ikke som treff eller bom). Et utfall er bare
--     gyldig på en lukket loop, og nullstilles når loopen gjenåpnes (samme rad, se upsert i open-loop-service.ts) - et MERKET utfall flyttes da til `closure_history` (punkt 3).
--  2. `confidence_basis`: hvorfor `confidence` ble som den ble (basisverdi, hver justering med begrunnelse, tak, kalibrering) - forklarbart, ingen persondata. NULL til første sveip
--     etter denne migrasjonen. En detektor kan sette `{"intrinsic_signals": n}` (antall uavhengige signalfamilier regelen selv fant); sveipet leser det og skriver den fulle forklaringen.
--  3. `closure_history`: tidligere MERKEDE lukkinger (acted/dismissed) av en loop som siden er gjenåpnet av samme vilkår - `[{outcome, confidence, closed_at}]`, de nyeste (maks 100).
--     Uten den ville et utfall forsvunnet når loopen gjenåpnes (7-dagers-undertrykkelsen utløper mens vilkåret fortsatt holder): kun lukkinger som faktisk løste saken ville overlevd som
--     kalibreringsgrunnlag, og «avvist, men vilkåret holder» ville blitt usynlig (survivorship) - treffraten ville blitt overvurdert. Ingen persondata: kun utfall, tall og tidspunkt.

ALTER TABLE business_open_loops
  ADD COLUMN resolution_outcome text,
  ADD COLUMN confidence_basis   jsonb,
  ADD COLUMN closure_history    jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE business_open_loops
  ADD CONSTRAINT business_open_loops_resolution_outcome_check CHECK (resolution_outcome IS NULL OR resolution_outcome IN ('acted', 'dismissed', 'condition_cleared')),
  ADD CONSTRAINT business_open_loops_outcome_needs_resolved CHECK (resolution_outcome IS NULL OR status = 'resolved'),
  ADD CONSTRAINT business_open_loops_closure_history_array CHECK (jsonb_typeof(closure_history) = 'array' AND jsonb_array_length(closure_history) <= 100);

-- Eksisterende automatisk lukkede loops får utfallet de allerede hadde i praksis (resolution_reason er den kjente markøren fra sveipet).
UPDATE business_open_loops
   SET resolution_outcome = 'condition_cleared'
 WHERE status = 'resolved' AND resolution_reason = 'condition_no_longer_true' AND resolution_outcome IS NULL;
