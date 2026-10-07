-- JARVIS-025 / D-438: den globale infra-eksekusjonsmodusen (NORMAL/DEGRADED/PAUSED) var prosess-lokal, så en pause via API-et nådde aldri workeren.
-- Den lagres nå i den eksisterende `owner_control_state` (samme «rad = aktiv, ingen rad = NORMAL»-mønster som kill_switch): kind `infra_mode`, ett
-- reservert mål `GLOBAL`. `reason` bærer {mode, reason, at} som JSON.
ALTER TABLE owner_control_state DROP CONSTRAINT owner_control_state_control_kind_check;
ALTER TABLE owner_control_state
  ADD CONSTRAINT owner_control_state_control_kind_check
  CHECK (control_kind IN ('kill_switch', 'connector_freeze', 'credential_revocation', 'infra_mode'));
ALTER TABLE owner_control_state
  ADD CONSTRAINT owner_control_state_infra_mode_target_ck
  CHECK (control_kind <> 'infra_mode' OR control_target = 'GLOBAL');
