-- WP-G2c (D-483, JARVIS-113 b, Q-73 pkt 10): AVSTEMMING av `outcome_unknown` i handlingsjournalen (`personal_action_journal`, migrasjon 125).
--
-- Migrasjon 125 sier i toppkommentaren at en `outcome_unknown`-rad blir staaende «til en avstemming har satt applied/failed» og (review A LOW-9) at INGEN kode avstemmer. Den setningen er FORELDET fra denne migrasjonen:
-- eier-ruten `POST /personal/actions/reconcile` (`modules/tool-gateway/src/personal/action-reconcile.ts`) leser maalets faktiske tilstand via de EKSISTERENDE leseveiene (aldri skrive-verktoeyet, aldri automatisk
-- retry) og setter raden `applied` KUN naar den oenskede sluttilstanden er bevist, `failed` KUN naar det er bevist at handlingen ikke skjedde, ellers forblir den `outcome_unknown` med tidspunkt og begrunnelse.
-- 125 er UENDRET (en allerede anvendt migrasjon kan ikke endres, selv ikke kommentaren: `migration_checksum_mismatch`); denne migrasjonen og runbooken (docs/runbooks/WPG2_PERSONAL.md, avsnitt 2.7) er den gjeldende sannheten.
--
-- Hva som trengs i databasen:
--   * `request_params`: de VALIDERTE parameterne forespoerselen hadde (kun det handlingens strenge skjema godtar: entitets-/koeyretoey-id, boolske verdier, modus, forutsetnings-markoerer - aldri alarmkode, token eller fritekst). Uten dem kan
--     avstemmingen ikke vite hva «oensket sluttilstand» er (journalen hadde kun en digest). Uforanderlig (trigger). Integritet: avstemmingen regner digesten paa nytt og avviser en rad der den ikke stemmer. NULL for rader fra foer 144 og for
--     forespoerseler som ikke bestod skjemaet (de blir uansett `failed`): slike rader kan aldri avstemmes (forblir `outcome_unknown` med grunnen `request_params_missing`).
--   * `reconcile_attempts`/`reconciled_at`/`reconcile_basis`/`reconciled_state`: hvor mange avstemmingsfoersoek raden har hatt, tidspunktet for det siste, en kort KODE for hvorfor raden ble avgjort eller staar (aldri utstyrets tekst) og den
--     redigerte nåtilstanden som ble lest (kun enumererte tilstandsord, tall og tidsstempler). Det opprinnelige `before_state`/`after_state`/`external_id` roeres ALDRI av avstemmingen (bevis for det som skjedde den gangen).
-- Triggerregler (i tillegg til de fra 125, uendret): `request_params` er uforanderlig; teller og avstemmingsfelt endres bare sammen og bare paa en rad som er `outcome_unknown` (teller +1 per foersoek); en terminal rad (`applied`/`failed`)
-- kan aldri faa endret avstemmingsfelt; en `requested`-rad har aldri vaert avstemt. Kun `outcome_unknown -> applied|failed` (som i 125) er lovlige statusoverganger; ingen ny overgang er innfoert.
-- Ingen hemmeligheter lagres her. Tilbakerulling: kolonnene er additive; en eldre kodeversjon ignorerer dem (SELECT * gir ekstra kolonner), og triggeren kan settes tilbake til 125-versjonen.

ALTER TABLE personal_action_journal
  ADD COLUMN request_params     jsonb,
  ADD COLUMN reconcile_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN reconciled_at      timestamptz,
  ADD COLUMN reconcile_basis    text,
  ADD COLUMN reconciled_state   jsonb;

ALTER TABLE personal_action_journal
  ADD CONSTRAINT personal_action_journal_request_params_shape CHECK (request_params IS NULL OR (jsonb_typeof(request_params) = 'object' AND octet_length(request_params::text) <= 4000)),
  ADD CONSTRAINT personal_action_journal_reconcile_attempts_nonneg CHECK (reconcile_attempts >= 0),
  ADD CONSTRAINT personal_action_journal_reconcile_basis_code CHECK (reconcile_basis IS NULL OR reconcile_basis ~ '^[a-z][a-z0-9_:.-]{0,79}$'),
  ADD CONSTRAINT personal_action_journal_reconcile_state_shape CHECK (reconciled_state IS NULL OR (jsonb_typeof(reconciled_state) = 'object' AND octet_length(reconciled_state::text) <= 8000)),
  -- Teller, tidspunkt og begrunnelse hoerer sammen: enten har raden aldri vaert avstemt (alt tomt), eller den har tidspunkt og begrunnelse for siste foersoek.
  ADD CONSTRAINT personal_action_journal_reconcile_complete CHECK (
    (reconcile_attempts = 0 AND reconciled_at IS NULL AND reconcile_basis IS NULL AND reconciled_state IS NULL)
    OR (reconcile_attempts > 0 AND reconciled_at IS NOT NULL AND reconcile_basis IS NOT NULL)
  ),
  -- Kun en rad som har vaert `outcome_unknown` kan ha vaert avstemt.
  ADD CONSTRAINT personal_action_journal_reconcile_not_before_unknown CHECK (status <> 'requested' OR reconcile_attempts = 0);

-- Uforanderlighet + lovlige statusoverganger (125-reglene uendret) + avstemmingsreglene over. CREATE OR REPLACE: triggeren fra 125 peker allerede paa funksjonen.
CREATE OR REPLACE FUNCTION personal_action_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_id IS DISTINCT FROM OLD.action_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.memory_space_id IS DISTINCT FROM OLD.memory_space_id
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.tool_id IS DISTINCT FROM OLD.tool_id OR NEW.action IS DISTINCT FROM OLD.action OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
     OR NEW.risk_direction IS DISTINCT FROM OLD.risk_direction OR NEW.target_ref IS DISTINCT FROM OLD.target_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.actor_person_id IS DISTINCT FROM OLD.actor_person_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     -- Proveniens (regel 4, fiks-runde review A LOW-6): korrelasjons-id-ene og opprettelsestidspunktet kan ikke omskrives etterpaa.
     OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     -- 144: de validerte parameterne forespoerselen hadde er bevis for hva som ble bedt om (avstemmingen leser dem) og kan ikke omskrives.
     OR NEW.request_params IS DISTINCT FROM OLD.request_params THEN
    RAISE EXCEPTION 'personal_action_journal_immutable_column' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'requested' AND NEW.status NOT IN ('requested', 'applied', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'personal_action_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'outcome_unknown' AND NEW.status NOT IN ('outcome_unknown', 'applied', 'failed') THEN
    RAISE EXCEPTION 'personal_action_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  -- Terminale statuser (applied/failed) endres aldri igjen (heller ikke ferdigstillingstidspunktet eller avstemmingsfeltene).
  IF OLD.status IN ('applied', 'failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.before_state IS DISTINCT FROM OLD.before_state OR NEW.after_state IS DISTINCT FROM OLD.after_state
     OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.reconcile_attempts IS DISTINCT FROM OLD.reconcile_attempts OR NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at OR NEW.reconcile_basis IS DISTINCT FROM OLD.reconcile_basis
     OR NEW.reconciled_state IS DISTINCT FROM OLD.reconciled_state) THEN
    RAISE EXCEPTION 'personal_action_journal_terminal_status' USING ERRCODE = '23514';
  END IF;
  -- 144: avstemmingen. Telleren oeker med NØYAKTIG 1 per foersoek og bare paa en rad som er `outcome_unknown`; tidspunkt, begrunnelse og lest tilstand endres bare sammen med telleren (aldri alene, aldri bakover).
  IF NEW.reconcile_attempts IS DISTINCT FROM OLD.reconcile_attempts THEN
    IF OLD.status <> 'outcome_unknown' OR NEW.reconcile_attempts <> OLD.reconcile_attempts + 1 THEN
      RAISE EXCEPTION 'personal_action_journal_invalid_reconcile' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.reconciled_at IS DISTINCT FROM OLD.reconciled_at OR NEW.reconcile_basis IS DISTINCT FROM OLD.reconcile_basis OR NEW.reconciled_state IS DISTINCT FROM OLD.reconciled_state THEN
    RAISE EXCEPTION 'personal_action_journal_invalid_reconcile' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
