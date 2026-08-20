-- D-97: delt (SHARED_RUNTIME) GitHub rate-limit-tilstand - global infrastruktur-
-- tilstand keyet paa credential_ref (ALDRI raatt token), IKKE tenant-forretnings-
-- data. Speiler bevisst scheduler_state (013_scheduler_state.sql): ingen
-- tenant_id, ingen RLS - samme presedens for global, ikke-tenant infra-tilstand.
CREATE TABLE github_rate_limit_state (
  credential_ref          text PRIMARY KEY,
  state                   text NOT NULL DEFAULT 'NORMAL' CHECK (state IN ('NORMAL', 'MUTATIONS_THROTTLED', 'PROVIDER_THROTTLED')),
  cooldown_until          timestamptz,
  retry_after_source      text CHECK (retry_after_source IN ('provider', 'jarvis_fallback')),
  consecutive_violations  integer NOT NULL DEFAULT 0,
  primary_limit           integer,
  primary_remaining       integer,
  primary_used            integer,
  primary_reset           timestamptz,
  primary_resource        text,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON github_rate_limit_state TO jarvis_app;
