-- WP-T1 K5 (JARVIS-103, Q-63 pkt 7, D-497): avstemming og utloep av `reserved`- og `unverified`-rader i ToolGateway-ledgeren (`tool_executions`).
--
-- Foer: en `unverified`-rad (utfallet kunne ikke bekreftes) og en `reserved`-rad som aldri ble ferdigstilt (krasj/SIGKILL midt i kallet) staar for alltid. Samme-noekkel-retry blokkeres for alltid, og ingen
-- jobb flytter dem eller sier fra til eieren. Dette er riktig fail-closed (aldri en automatisk retry av en sideeffekt som kan ha skjedd), men uten en vei ut.
--
-- Naa (kun naar `JARVIS_TOOL_LEDGER_RECONCILE=on`; med flagget av skrives aldri disse statusene):
--   * `reserved`   eldre enn TTL  ->  `unknown_outcome`  (utfallet er UKJENT; aldri automatisk retry; blokkerer fortsatt samme noekkel)
--   * `unverified` eldre enn TTL  ->  `needs_resolution` (utfoert men ikke bekreftet; staar i eierens koe med krav om en avgjoerelse)
--   * EIEREN avgjoer raden etter en manuell sjekk hos leverandoeren (kun ruten `POST /tool-ledger/resolve`, eier + step-up for klasse C/D):
--       `executed`      -> status `succeeded` (en retry med samme noekkel gir det lagrede resultatet, `deduplicated`),
--       `not_executed`  -> status `failed`    (noekkelen er frigitt: en retry med samme noekkel utfoeres paa nytt - eierens ansvar etter sjekken).
--     Avgjoerelsen kan tas for ALLE ikke-endelige statuser (ogsaa `unverified` foer utloep) og for en `reserved` rad som er eldre enn gulvet; aldri for en ung `reserved` (kan vaere under utfoerelse).
--
-- Kolonner (additive, alle NULL for eksisterende rader; opprinnelig bevis - status-aarsak, before_state, after_state, external_id - roeres ALDRI av avstemmingen):
--   `status_before_reconcile` (reserved|unverified), `reconciled_at`, `reconcile_basis` (kort kode, aldri tekst fra leverandoeren): satt av utloepssveipet.
--   `resolved_at`, `resolved_by` (person-id), `resolution` (executed|not_executed): satt KUN av eier-avgjoerelsen. Eierens egen merknad lagres ikke her, kun i revisjonsraden `tool.ledger_resolved`.
--
-- Databasevern (trigger `tool_executions_guard`, i tillegg til applikasjonens regler): de nye statusene kan KUN settes fra riktig utgangsstatus og kun naar raden er gammel nok (gulv: `reserved` 10 min, `unverified`
-- 1 time, uavhengig av konfigurasjon - en bug eller TTL=0 kan aldri merke et kall som kan vaere under utfoerelse); en rad forlater `unknown_outcome`/`needs_resolution` kun til `succeeded`/`failed` og kun med en
-- fullstendig avgjoerelse som stemmer med statusen (`executed` <-> `succeeded`); avgjoerelsesfeltene settes aldri uten en slik overgang; en re-armert rad (`failed` -> `reserved`, retry etter frigjort noekkel) faar
-- avstemmings- og avgjoerelsesfeltene nullstilt (en ny utfoerelse har ikke vaert avstemt). Alle andre overganger (reserved -> succeeded/failed/unverified, failed -> reserved) er UENDRET (ingen begrensning innfoert).
-- Identitetskolonnene og `request_digest` (153) beskyttes som foer av de kolonnevise UPDATE-rettighetene (011/070): runtime-rollen kan aldri endre dem. Triggeren legger bevisst IKKE til noe nytt for administrator-
-- vedlikehold (reparasjoner og tester som setter opp rader direkte).

-- Retensjon (073): `prune_operational_data` sletter fortsatt kun avsluttede rader (`succeeded`/`failed`) eldre enn 30 dager og aldri `reserved`/`unverified`/`unknown_outcome`/`needs_resolution`. En avgjort rad
-- blir `succeeded`/`failed` og kan senere ryddes som andre; beviset for avgjoerelsen staar i `audit_events` (append-only). Erasure: tabellen er APPEND_ONLY_EVIDENCE (d395); ingen ny tabell.
-- Expand/contract: additiv (nye statuser, nullbare kolonner, indeks). En eldre kodeversjon ignorerer kolonnene; den kjenner ikke de nye statusene og behandler dem som en rad under utfoerelse (blokkerer retry, aldri en
-- ny mutasjon). Tilbakerulling: sett flagget `off` (sveipet og ruten stopper); allerede avstemte rader forblir i de nye statusene til eieren har avgjort dem (de er fortsatt synlige i `ToolGateway.reconcile()`).

ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_status_check
  CHECK (status IN ('reserved', 'succeeded', 'failed', 'unverified', 'unknown_outcome', 'needs_resolution'));

ALTER TABLE tool_executions
  ADD COLUMN status_before_reconcile text,
  ADD COLUMN reconciled_at           timestamptz,
  ADD COLUMN reconcile_basis         text,
  ADD COLUMN resolved_at             timestamptz,
  ADD COLUMN resolved_by             text,
  ADD COLUMN resolution              text;

ALTER TABLE tool_executions
  ADD CONSTRAINT tool_executions_status_before_reconcile_ck CHECK (status_before_reconcile IS NULL OR status_before_reconcile IN ('reserved', 'unverified')),
  ADD CONSTRAINT tool_executions_reconcile_basis_ck CHECK (reconcile_basis IS NULL OR reconcile_basis ~ '^[a-z][a-z0-9_:.-]{0,79}$'),
  ADD CONSTRAINT tool_executions_resolution_ck CHECK (resolution IS NULL OR resolution IN ('executed', 'not_executed')),
  ADD CONSTRAINT tool_executions_resolved_by_ck CHECK (resolved_by IS NULL OR (char_length(resolved_by) BETWEEN 1 AND 200)),
  -- Avstemmingsfeltene hoerer sammen: enten alle tomme (aldri avstemt) eller alle satt.
  ADD CONSTRAINT tool_executions_reconcile_complete CHECK (
    (reconciled_at IS NULL AND reconcile_basis IS NULL AND status_before_reconcile IS NULL)
    OR (reconciled_at IS NOT NULL AND reconcile_basis IS NOT NULL AND status_before_reconcile IS NOT NULL)
  ),
  -- Det samme for avgjoerelsen.
  ADD CONSTRAINT tool_executions_resolution_complete CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL AND resolution IS NULL)
    OR (resolved_at IS NOT NULL AND resolved_by IS NOT NULL AND resolution IS NOT NULL)
  ),
  -- De nye statusene har alltid en avstemming bak seg, og kommer fra riktig utgangsstatus (IS NOT DISTINCT FROM: en CHECK som evaluerer til NULL slipper ellers gjennom, og en rad uten avstemming ville vaert godtatt).
  ADD CONSTRAINT tool_executions_unknown_outcome_ck CHECK (status <> 'unknown_outcome' OR status_before_reconcile IS NOT DISTINCT FROM 'reserved'),
  ADD CONSTRAINT tool_executions_needs_resolution_ck CHECK (status <> 'needs_resolution' OR status_before_reconcile IS NOT DISTINCT FROM 'unverified'),
  -- En avgjoerelse stemmer med statusen: utfoert = succeeded, ikke utfoert = failed (gjelder til raden re-armeres; da nullstilles den).
  ADD CONSTRAINT tool_executions_resolution_status_ck CHECK (
    resolution IS NULL OR (resolution = 'executed' AND status = 'succeeded') OR (resolution = 'not_executed' AND status = 'failed')
  );

-- Kolonnevise rettigheter (som 011/070): runtime kan skrive KUN disse nye kolonnene (aldri request_digest, aldri identitetskolonnene). Ingen ny DELETE-rettighet.
GRANT UPDATE (status_before_reconcile, reconciled_at, reconcile_basis, resolved_at, resolved_by, resolution) ON tool_executions TO jarvis_app;

-- Koen over rader som ikke er avsluttet (sveip og eierens liste soeker paa tenant + alder blant disse): liten delvis indeks.
CREATE INDEX tool_executions_open_idx ON tool_executions (tenant_id, executed_at)
  WHERE status IN ('reserved', 'unverified', 'unknown_outcome', 'needs_resolution');

CREATE OR REPLACE FUNCTION tool_executions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Re-arm (retry etter at noekkelen er frigitt eller leverandoeren avviste): en NY utfoerelse har ikke vaert avstemt eller avgjort.
  IF OLD.status = 'failed' AND NEW.status = 'reserved' THEN
    NEW.status_before_reconcile := NULL;
    NEW.reconciled_at := NULL;
    NEW.reconcile_basis := NULL;
    NEW.resolved_at := NULL;
    NEW.resolved_by := NULL;
    NEW.resolution := NULL;
  END IF;

  -- Inn i de nye statusene: kun reserved -> unknown_outcome og unverified -> needs_resolution, med gulv paa alder og med avstemmingsfeltene satt.
  IF NEW.status IN ('unknown_outcome', 'needs_resolution') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NOT ((OLD.status = 'reserved' AND NEW.status = 'unknown_outcome') OR (OLD.status = 'unverified' AND NEW.status = 'needs_resolution')) THEN
      RAISE EXCEPTION 'tool_executions_invalid_reconcile_transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.executed_at > now() - (CASE OLD.status WHEN 'reserved' THEN interval '10 minutes' ELSE interval '1 hour' END) THEN
      RAISE EXCEPTION 'tool_executions_reconcile_too_early' USING ERRCODE = '23514';
    END IF;
    IF NEW.reconciled_at IS NULL OR NEW.reconcile_basis IS NULL OR NEW.status_before_reconcile IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'tool_executions_reconcile_incomplete' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Ut av de nye statusene: kun til succeeded/failed, og kun med en fullstendig avgjoerelse (feltene kontrolleres for samsvar under).
  IF OLD.status IN ('unknown_outcome', 'needs_resolution') AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'tool_executions_invalid_resolution_transition' USING ERRCODE = '23514';
    END IF;
    IF NEW.resolved_at IS NULL OR NEW.resolved_by IS NULL OR NEW.resolution IS NULL THEN
      RAISE EXCEPTION 'tool_executions_resolution_incomplete' USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Avgjoerelsesfeltene: settes kun sammen med en overgang til succeeded/failed fra en ikke-endelig status, fullstendig og i samsvar med statusen. (Nullstillingen ved re-arm over er lovlig.)
  IF (NEW.resolved_at IS DISTINCT FROM OLD.resolved_at OR NEW.resolved_by IS DISTINCT FROM OLD.resolved_by OR NEW.resolution IS DISTINCT FROM OLD.resolution)
     AND NOT (OLD.status = 'failed' AND NEW.status = 'reserved') THEN
    IF NEW.resolved_at IS NULL OR NEW.resolved_by IS NULL OR NEW.resolution IS NULL THEN
      RAISE EXCEPTION 'tool_executions_resolution_incomplete' USING ERRCODE = '23514';
    END IF;
    IF OLD.status NOT IN ('reserved', 'unverified', 'unknown_outcome', 'needs_resolution') OR NEW.status NOT IN ('succeeded', 'failed') THEN
      RAISE EXCEPTION 'tool_executions_invalid_resolution_transition' USING ERRCODE = '23514';
    END IF;
    IF OLD.status = 'reserved' AND OLD.executed_at > now() - interval '10 minutes' THEN
      RAISE EXCEPTION 'tool_executions_resolve_too_early' USING ERRCODE = '23514';
    END IF;
    IF (NEW.resolution = 'executed') <> (NEW.status = 'succeeded') THEN
      RAISE EXCEPTION 'tool_executions_resolution_status_mismatch' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER tool_executions_guard BEFORE UPDATE ON tool_executions FOR EACH ROW EXECUTE FUNCTION tool_executions_guard();
