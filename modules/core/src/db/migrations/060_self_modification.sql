-- Task #121 (D-214): to-lags selvendrings-modell (D-208 sin vedtatte retning,
-- IKKE full ugjennomgått selvpatching - se docs/DECISIONS_AND_ASSUMPTIONS.md
-- D-208/D-214). Sporer HVER selvendrings-forespørsel - BÅDE den ene
-- zero-review-veien (et navngitt, skjemavalidert personlighets-konfig-lag,
-- automerges når CI er grønt og diffen fortsatt er eksakt den forventede
-- ene filen) OG requires_approval-veien (alt annet ikke-forbudt, venter på
-- Telegram-basert eier-godkjenning via den eksisterende, betrodde eier-
-- chat-bindingen - se modules/tool-gateway/src/live-transports.ts sin
-- TelegramCommandPoller).
--
-- INGEN `tenant_id`, INGEN RLS - selvendring er en GLOBAL, sovereign eier-
-- handling over DEN DELTE kodebasen/konfigurasjonen, ikke en tenant-
-- partisjonert ressurs. Samme presedens som `owner_control_state`
-- (058_owner_control_authority.sql) og `situation_domain_pauses`
-- (056_situations.sql) - autorisasjon håndheves i applikasjonskoden
-- (SelfModificationService), ikke via DB-grants.
--
-- `risk`/`status` er BEGGE tekst-CHECK-håndhevet (samme mønster som
-- `owner_control_state.control_kind`) - en fremtidig kodefeil kan aldri
-- sette en verdi klassifiseringsmotoren/tilstandsmaskinen ikke selv
-- definerer.
CREATE TABLE self_modification_requests (
  request_id                text PRIMARY KEY,
  kind                       text NOT NULL,
  risk                       text NOT NULL CHECK (risk IN ('zero_review', 'requires_approval', 'forbidden')),
  target_paths               text[] NOT NULL,
  branch                     text NOT NULL,
  pr_number                  text NOT NULL,
  pr_url                     text NOT NULL,
  status                     text NOT NULL CHECK (status IN (
    'pending_ci', 'merged', 'ci_failed', 'awaiting_approval', 'approved', 'rejected', 'expired'
  )),
  requested_by_person_id     text NOT NULL REFERENCES people (person_id),
  summary                    text NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  resolved_at                timestamptz,
  resolved_by_person_id      text REFERENCES people (person_id)
);

-- Sveipen (SelfModificationService.sweepPendingRequests()) spør gjentatte
-- ganger etter samme, lille undergruppe (status IN ('pending_ci',
-- 'awaiting_approval')) - en delvis indeks er billig og holder sveipen rask
-- selv når historikken av FERDIGE forespørsler (merged/rejected/osv.) vokser.
CREATE INDEX self_modification_requests_open_idx
  ON self_modification_requests (status)
  WHERE status IN ('pending_ci', 'awaiting_approval');

GRANT SELECT, INSERT, UPDATE, DELETE ON self_modification_requests TO jarvis_app;
