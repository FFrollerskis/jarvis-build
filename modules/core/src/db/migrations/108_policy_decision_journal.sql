-- WP-K (D-471, JARVIS-053/054): varig, tenant-skopet JOURNAL over Policy Gateway-avgjørelser.
-- Forward-safe (expand-only): en ny tabell + en ny definer-funksjon. Ingen eksisterende tabell/kolonne endres.
--
-- FØR: `PolicyGateway` la hver avgjørelse i en ringbuffer i minnet (D-393) - borte ved omstart, og aldri korrelert med revisjonsraden handlingen førte til.
-- NÅ: `PgPolicyAuditSink` (@jarvis/core) skriver hver avgjørelse hit (kun når eieren slår på JARVIS_POLICY_AUDIT_SINK=db). `decision_id` er nøkkelen revisjonsraden
-- (`audit_events.payload->>'policy_decision_id'`) deler, og `task_id`/`trace_id` binder avgjørelsen til jobb/planlagt kjøring/samtaletur.
--
-- Journalen inneholder BARE metadata (person/sesjon/verktøy/handling/klasse/avgjørelse/grunnkode) - aldri parametre, godkjenningsinnhold eller prompts.
-- `audit_events` er fortsatt DEN autoritative revisjonen (append-only, ingen oppbevaringsgrense: eierbeslutning, JARVIS-074). Denne journalen er et SUPPLEMENT med begrenset
-- oppbevaring (standard 90 dager, aldri under 30) - samme design som migrasjon 073: en SECURITY DEFINER-funksjon eid av `jarvis_definer` med faste gulv i selve RLS-policyene;
-- `jarvis_app` får EXECUTE, ikke DELETE, så en kompromittert runtime kan ikke slette ferske avgjørelser.
--
-- Append-only for alle roller: ingen UPDATE-grant og en trigger som avviser UPDATE. Sletting skjer kun via `prune_policy_decisions()`.

CREATE TABLE policy_decisions (
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  decision_id      text NOT NULL CHECK (char_length(decision_id) BETWEEN 8 AND 80),
  -- Policy-klokkens tidspunkt for avgjørelsen (oppbevaringsklokken); `recorded_at` er når raden ble skrevet (kan ligge etter: kø/backoff).
  decided_at       timestamptz NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  decision         text NOT NULL CHECK (decision IN ('ALLOW', 'DENY')),
  -- Maskinkode (f.eks. `class_c_sovereign_authority`, `kill_switch_active`) - sinken redigerer og kutter fritekst før lagring.
  reason           text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 160),
  person_id        text NOT NULL CHECK (char_length(person_id) BETWEEN 1 AND 200),
  -- Som `audit_events.actor_kind`: `system` for `person_id = 'system'` (aldri en fabrikkert person).
  actor_kind       text NOT NULL DEFAULT 'person' CHECK (actor_kind IN ('person', 'system')),
  session_id       text CHECK (session_id IS NULL OR char_length(session_id) <= 200),
  tool_id          text NOT NULL CHECK (char_length(tool_id) BETWEEN 1 AND 120),
  action           text NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
  capability_class text NOT NULL CHECK (capability_class IN ('A', 'B', 'C', 'D', 'unknown')),
  task_id          text CHECK (task_id IS NULL OR char_length(task_id) <= 200),
  trace_id         text CHECK (trace_id IS NULL OR char_length(trace_id) <= 200),
  process          text CHECK (process IS NULL OR char_length(process) <= 40),
  PRIMARY KEY (tenant_id, decision_id)
);
CREATE INDEX policy_decisions_tenant_time_idx ON policy_decisions (tenant_id, decided_at DESC);
CREATE INDEX policy_decisions_task_idx ON policy_decisions (tenant_id, task_id) WHERE task_id IS NOT NULL;
CREATE INDEX policy_decisions_trace_idx ON policy_decisions (tenant_id, trace_id) WHERE trace_id IS NOT NULL;
-- Oppbevaringssveipet skanner på tid på tvers av tenants.
CREATE INDEX policy_decisions_decided_idx ON policy_decisions (decided_at);

CREATE TRIGGER policy_decisions_no_update
  BEFORE UPDATE ON policy_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

GRANT SELECT, INSERT ON policy_decisions TO jarvis_app;

ALTER TABLE policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE policy_decisions FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_decisions_tenant ON policy_decisions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

-- Oppbevaring (samme mønster som 073): definer-rollen får kun de smale rettighetene funksjonen trenger, og to EKSPLISITTE policyer som binder det faste gulvet (30 dager)
-- i selve policyen - selv om funksjonen skulle misbrukes kan en fersk avgjørelse ikke slettes.
GRANT SELECT (tenant_id, decision_id, decided_at) ON policy_decisions TO jarvis_definer;
GRANT DELETE ON policy_decisions TO jarvis_definer;
CREATE POLICY policy_decisions_definer_prune_select ON policy_decisions FOR SELECT TO jarvis_definer
  USING (decided_at < now() - interval '30 days');
CREATE POLICY policy_decisions_definer_prune ON policy_decisions FOR DELETE TO jarvis_definer
  USING (decided_at < now() - interval '30 days');

CREATE OR REPLACE FUNCTION prune_policy_decisions(
  p_days  integer DEFAULT 90,
  p_batch integer DEFAULT 5000
) RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  n bigint;
  b integer := LEAST(GREATEST(COALESCE(p_batch, 5000), 100), 50000);
  d integer := GREATEST(COALESCE(p_days, 90), 30);
BEGIN
  WITH doomed AS (
    SELECT tenant_id, decision_id FROM policy_decisions WHERE decided_at < now() - make_interval(days => d) LIMIT b
  ) DELETE FROM policy_decisions p USING doomed WHERE p.tenant_id = doomed.tenant_id AND p.decision_id = doomed.decision_id;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

ALTER FUNCTION prune_policy_decisions(integer, integer) OWNER TO jarvis_definer;
REVOKE ALL ON FUNCTION prune_policy_decisions(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION prune_policy_decisions(integer, integer) TO jarvis_app;
