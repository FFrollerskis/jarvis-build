-- WP-G2 (UA-8 Personal Twin, D-464): HANDLINGSJOURNALEN for kritiske fysiske handlinger (hjem og bil) - `personal_action_journal`.
--
-- Jarvis' EGEN, kanoniske journal over «hva ble gjort i det fysiske hjemmet/bilen, hvem ba om det, hva var tilstanden før og hva viste readback etterpå» (D-64: Home Assistant og bil-API-et er
-- utførere og kilder til nåtilstand, journalen er Jarvis'). Den fyller det ToolGateway-ledgeren (`tool_executions`, nøklet på idempotensnøkkelen ALENE) ikke dekker i dette domenet:
--   * `request_digest` (sha256 av de kanoniserte parameterne): samme nøkkel med ANNEN nyttelast AVVISES, aldri «det lagrede resultatet» (samme prinsipp som `growth_write_journal`);
--   * før-/etter-tilstand (redigert, begrenset - kun enumererte tilstandsord, tall og tidsstempler) knyttet til MÅLET (entitets-/kjøretøy-id), slik at «feil sluttilstand» er ett oppslag;
--   * `outcome_unknown` er en førsteklasses status (UTFALL UKJENT etter en akseptert kommando, eller en sluttilstand som ikke ble bekreftet): raden blir stående til en avstemming har satt
--     `applied`/`failed` - en ny kommando med SAMME nøkkel utføres aldri. MERK (ærlig, review A LOW-9): triggeren TILLATER overgangen, men INGEN kode avstemmer i dag (`DEFERRED`: eier-rute/jobb); eieren
--     leser målets nåtilstand (`/personal/actions/read`) og avgjør selv;
--   * `risk_direction` (reduces/increases/neutral): om handlingen gjør noe TRYGGERE (låse, armere, lukke) eller mindre trygt (låse opp, avarmere, åpne). Det er faktaene en senere, eier-besluttet
--     autonomi-lemping ville støttet seg på (Q-G2-1); ingenting i koden lemper på step-up på grunnlag av den.
-- Kjerne-kolonnene er UFORANDERLIGE (trigger), og statusen kan bare gå requested -> applied|failed|outcome_unknown og outcome_unknown -> applied|failed. Terminale statuser endres aldri igjen.
-- Ingen hemmeligheter lagres her (alarmkoden/PIN ligger aldri i en journalrad). Hver rad er MERKET (regel 4): tenant + memory space + kilde + aktør + task_id/session_id/trace_id.
-- Komposittnøkkel mot (person, tenant)-medlemskap: aktøren MÅ være medlem av tenanten raden hevder å tilhøre (samme garanti som `health_metric_observations`/`context_observations`).

CREATE TABLE personal_action_journal (
  action_id         text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'home' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  domain            text NOT NULL CHECK (domain IN ('home', 'car')),
  tool_id           text NOT NULL CHECK (tool_id ~ '^[a-z][a-z0-9_-]{0,63}$'),
  action            text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_]{0,63}$'),
  risk_class        text NOT NULL CHECK (risk_class IN ('C', 'D')),
  risk_direction    text NOT NULL CHECK (risk_direction IN ('reduces', 'increases', 'neutral')),
  -- MÅLET (eierens egen entitet/kjøretøy-id) - peker, aldri innhold.
  target_ref        text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 200),
  idempotency_key   text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  request_digest    text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
  status            text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'applied', 'failed', 'outcome_unknown')),
  -- Trygg, kort feilkode (aldri leverandørtekst): `preflight_invalid:<kode>`, `tool_failed:<kode>`, `postcondition_mismatch`, `outcome_unknown:<kode>` ...
  failure_code      text CHECK (failure_code IS NULL OR char_length(failure_code) <= 160),
  before_state      jsonb,
  after_state       jsonb,
  external_id       text CHECK (external_id IS NULL OR char_length(external_id) <= 300),
  actor_person_id   text NOT NULL,
  source            text NOT NULL CHECK (source IN ('owner_route', 'script', 'system')),
  task_id           text,
  session_id        text,
  trace_id          text,
  -- Varslingsstatus (fiks-runde review A LOW-8): ble det umiddelbare eier-varselet levert? `NULL` = ikke forsøkt (avvist før handlingen) / ukjent; `false` + `notify_error` (kort, sanert kode) = handlingen står, men eieren ble IKKE varslet
  -- (retry-markør: en senere jobb/eier kan finne `notified = false`). Operasjonell metadata: kan oppdateres også etter terminal status (selve handlingens proveniens kan ikke).
  notified          boolean,
  notify_error      text CHECK (notify_error IS NULL OR char_length(notify_error) <= 160),
  requested_at      timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT personal_action_journal_completion CHECK (status = 'requested' OR completed_at IS NOT NULL OR status = 'outcome_unknown'),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (tenant_id, action_id),
  FOREIGN KEY (actor_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)
);
CREATE INDEX personal_action_journal_target_idx ON personal_action_journal (tenant_id, memory_space_id, domain, target_ref, requested_at DESC);
CREATE INDEX personal_action_journal_status_idx ON personal_action_journal (tenant_id, status, requested_at DESC);

-- Uforanderlighet + lovlige statusoverganger (deterministisk, i databasen): journalen kan ikke omskrives etterpå.
CREATE FUNCTION personal_action_journal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.action_id IS DISTINCT FROM OLD.action_id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.memory_space_id IS DISTINCT FROM OLD.memory_space_id
     OR NEW.domain IS DISTINCT FROM OLD.domain OR NEW.tool_id IS DISTINCT FROM OLD.tool_id OR NEW.action IS DISTINCT FROM OLD.action OR NEW.risk_class IS DISTINCT FROM OLD.risk_class
     OR NEW.risk_direction IS DISTINCT FROM OLD.risk_direction OR NEW.target_ref IS DISTINCT FROM OLD.target_ref OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.request_digest IS DISTINCT FROM OLD.request_digest OR NEW.actor_person_id IS DISTINCT FROM OLD.actor_person_id OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     -- Proveniens (regel 4, fiks-runde review A LOW-6): korrelasjons-id-ene og opprettelsestidspunktet kan ikke omskrives etterpå.
     OR NEW.task_id IS DISTINCT FROM OLD.task_id OR NEW.session_id IS DISTINCT FROM OLD.session_id OR NEW.trace_id IS DISTINCT FROM OLD.trace_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'personal_action_journal_immutable_column' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'requested' AND NEW.status NOT IN ('requested', 'applied', 'failed', 'outcome_unknown') THEN
    RAISE EXCEPTION 'personal_action_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  IF OLD.status = 'outcome_unknown' AND NEW.status NOT IN ('outcome_unknown', 'applied', 'failed') THEN
    RAISE EXCEPTION 'personal_action_journal_invalid_transition' USING ERRCODE = '23514';
  END IF;
  -- Terminale statuser (applied/failed) endres aldri igjen (heller ikke ferdigstillingstidspunktet).
  IF OLD.status IN ('applied', 'failed') AND (NEW.status IS DISTINCT FROM OLD.status OR NEW.before_state IS DISTINCT FROM OLD.before_state OR NEW.after_state IS DISTINCT FROM OLD.after_state
     OR NEW.failure_code IS DISTINCT FROM OLD.failure_code OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.completed_at IS DISTINCT FROM OLD.completed_at) THEN
    RAISE EXCEPTION 'personal_action_journal_terminal_status' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER personal_action_journal_guard BEFORE UPDATE ON personal_action_journal FOR EACH ROW EXECUTE FUNCTION personal_action_journal_guard();

-- Journal: SELECT/INSERT/UPDATE (statusoverganger, vokter over) + DELETE kun for Q-20-erasure.
GRANT SELECT, INSERT, UPDATE, DELETE ON personal_action_journal TO jarvis_app;

ALTER TABLE personal_action_journal ENABLE ROW LEVEL SECURITY;
ALTER TABLE personal_action_journal FORCE ROW LEVEL SECURITY;
CREATE POLICY personal_action_journal_tenant ON personal_action_journal
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY personal_action_journal_space ON personal_action_journal AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
