-- WP-G4 (D-466), UA-10 Proactive Situation Engine: samlet hendelsesabonnement, signallogg, modellassistert vurdering, tilbakemelding og
-- regeltuning. Bygger paa 056/057 (situations). Alt er DORMANT: tabellene er tomme med mindre JARVIS_SITUATION_SIGNALS=on.
--
-- D-64 (Core-vs-Adapter): Jarvis eier hele den kanoniske modellen (abonnement, signallogg, vurdering, tilbakemelding, tuning). Kildene
-- (Home Assistant, kamera, helse, hendelser) er kilder bak porter - ingen ny leverandoer, ingen kjerneavhengighet.
--
-- Begrensede data (helse, kamera): ingen av tabellene lagrer raa verdier. `situation_signal_log.facts` er en LUKKET, minimert
-- fakta-mengde (kategorier og grove tall, aldri maalinger, bilder, etiketter eller tekst fra kilden), validert i applikasjonen og
-- begrenset i stoerrelse her. Alle rader er merket tenant, memory space, kilde og task_id/session_id (CLAUDE.md regel 4).
--
-- 1) Additive endringer paa eksisterende tabeller (flagg AV = uendret oppfoersel):
--    - (`situations_scope_uq` (situation_id, tenant_id, memory_space_id) finnes allerede fra 059_governance.sql og er maalet for de
--      sammensatte FK-ene under; den trenger ikke legges til paa nytt.)
--    - `situation_notification_policies.critical_bypass_quiet`: eierens EKSPLISITTE valg om at et lukket sett sikkerhetssignaler
--      (vannlekkasje, utloest alarm) faar bryte stille timer. Standard false = stille timer virker som foer.

ALTER TABLE situation_notification_policies ADD COLUMN critical_bypass_quiet boolean NOT NULL DEFAULT false;

--    - `situation_autonomy_policies.expires_at`: valgfri utloepstid paa eierens autonomi-binding. NULL = ingen utloep (som foer).
--      En utloept binding gir ingen ACT (`autoActPending` sjekker den ved utvalg OG rett foer hvert kall).
ALTER TABLE situation_autonomy_policies ADD COLUMN expires_at timestamptz;

-- 2) Abonnementsregisteret. Eieren registrerer EKSPLISITT hvilke kilder/hendelsestyper/filtre som faar mate motoren; fravaer av
--    abonnement = signalet forkastes (fail-closed). `domain` er situasjonsdomenet abonnementet mater (brukes av pausen).
--    `filter` er et LUKKET objekt per kilde (valideres i applikasjonen); `filter_digest` gjoer registrering idempotent.
CREATE TABLE situation_subscriptions (
  subscription_id     text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  source              text NOT NULL
    CHECK (source IN ('home_assistant','vision','health','incident','communications','business')),
  event_type          text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{2,59}$'),
  domain              text NOT NULL CHECK (length(domain) BETWEEN 1 AND 40 AND domain <> '*'),
  filter              jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(filter) = 'object' AND pg_column_size(filter) <= 8192),
  filter_digest       text NOT NULL CHECK (filter_digest ~ '^[0-9a-f]{64}$'),
  enabled             boolean NOT NULL DEFAULT true,
  created_by_person_id text NOT NULL REFERENCES people (person_id),
  task_id             text,
  session_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT situation_subscriptions_actor_scope_fk
    FOREIGN KEY (created_by_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id),
  UNIQUE (tenant_id, memory_space_id, source, event_type, filter_digest)
);
CREATE INDEX situation_subscriptions_lookup_idx ON situation_subscriptions (tenant_id, memory_space_id, source, enabled);

-- 3) Signallogg: ETT innslag per vellykket evaluert signal (episode + nivaa), med det motoren gjorde. Brukes til gjenkjenning av
--    samme hendelse fra flere kilder, til simulering ("hva om") og til statistikk. `facts` er minimert (se filhodet). Retensjon:
--    daglig opprydding (standard 30 dager, JARVIS_SITUATION_LOG_RETENTION_DAYS) og Q-20-erasure.
CREATE TABLE situation_signal_log (
  signal_id           text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  source              text NOT NULL
    CHECK (source IN ('home_assistant','vision','health','incident','communications','business')),
  event_type          text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_]{2,59}$'),
  domain              text NOT NULL CHECK (length(domain) BETWEEN 1 AND 40 AND domain <> '*'),
  source_ref          text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 200),
  detection_key       text NOT NULL CHECK (length(detection_key) BETWEEN 1 AND 300),
  situation_id        text NOT NULL,
  -- Peker (ikke FK): abonnementet kan slettes uten at historikken forsvinner.
  subscription_id     text,
  occurred_at         timestamptz NOT NULL,
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  outcome             text NOT NULL CHECK (outcome IN ('created','updated')),
  stage_after         text NOT NULL
    CHECK (stage_after IN ('ignore','remember','inform','suggest','act','act_notify','escalate')),
  priority            text NOT NULL CHECK (priority IN ('low','normal','high')),
  notified            boolean NOT NULL DEFAULT false,
  facts               jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(facts) = 'object' AND pg_column_size(facts) <= 2048),
  task_id             text,
  session_id          text,
  UNIQUE (tenant_id, memory_space_id, source, source_ref),
  CONSTRAINT situation_signal_log_situation_scope_fk
    FOREIGN KEY (situation_id, tenant_id, memory_space_id)
    REFERENCES situations (situation_id, tenant_id, memory_space_id) ON DELETE CASCADE
);
CREATE INDEX situation_signal_log_key_idx ON situation_signal_log (tenant_id, memory_space_id, detection_key, occurred_at);
CREATE INDEX situation_signal_log_retention_idx ON situation_signal_log (tenant_id, recorded_at);

-- 4) Eierens tilbakemelding ("nyttig"/"stoey") paa en situasjon. Append-only bortsett fra `consumed_at` (kolonne-grant, aldri verdict): en
--    endret mening er en NY rad. En stemme som har utloest en terskelendring (eller blitt nullstilt av en tilbakestilling) markeres brukt og
--    teller ikke mer - hvert steg krever tre NYE, enige stemmer, og en tilbakestilling kan ikke omgaas av gamle stemmer.
CREATE TABLE situation_feedback (
  feedback_id         text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  situation_id        text NOT NULL,
  rule_key            text NOT NULL CHECK (rule_key ~ '^[a-z_]{3,30}:[a-z_]{3,60}$'),
  verdict             text NOT NULL CHECK (verdict IN ('useful','noise')),
  actor_person_id     text NOT NULL REFERENCES people (person_id),
  task_id             text,
  session_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  consumed_at         timestamptz,
  CONSTRAINT situation_feedback_actor_scope_fk
    FOREIGN KEY (actor_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id),
  CONSTRAINT situation_feedback_situation_scope_fk
    FOREIGN KEY (situation_id, tenant_id, memory_space_id)
    REFERENCES situations (situation_id, tenant_id, memory_space_id) ON DELETE CASCADE
);
CREATE INDEX situation_feedback_rule_idx ON situation_feedback (tenant_id, memory_space_id, rule_key, created_at);

-- 5) Regeltuning: gjeldende terskel per (tenant, space, regel) etter eierens tilbakemelding. Verdien klemmes ALLTID mot kodens harde
--    graenser ved bruk (`resolveRuleThreshold`), uansett hva som staar her. Hver endring revideres i `audit_events` i samme
--    transaksjon (`situation.rule_tuned`). Ingen regel, kode eller prompt endres - kun et tall innenfor graensene.
CREATE TABLE situation_rule_tuning (
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  rule_key            text NOT NULL CHECK (rule_key ~ '^[a-z_]{3,30}:[a-z_]{3,60}$'),
  threshold           numeric NOT NULL CHECK (threshold > 0 AND threshold <= 100000),
  reason              text NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  updated_by_person_id text NOT NULL REFERENCES people (person_id),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, memory_space_id, rule_key),
  CONSTRAINT situation_rule_tuning_actor_scope_fk
    FOREIGN KEY (updated_by_person_id, tenant_id) REFERENCES person_tenants (person_id, tenant_id)
);

-- 6) Modellassistert vurdering (kategori/prioritetsforslag/forklaring). Modellens svar er UBETRODD og lagres bare etter streng
--    validering mot lukkede sett. Ett kall per (situasjon, input-digest): samme input spoerr aldri modellen to ganger.
CREATE TABLE situation_assessments (
  assessment_id       text PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id     text NOT NULL
    CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  situation_id        text NOT NULL,
  input_digest        text NOT NULL CHECK (input_digest ~ '^[0-9a-f]{64}$'),
  status              text NOT NULL CHECK (status IN ('applied','rejected')),
  category            text CHECK (category IS NULL OR category IN ('routine','attention','risk','noise','unknown')),
  priority_hint       text CHECK (priority_hint IS NULL OR priority_hint IN ('low','normal','high')),
  explanation         text CHECK (explanation IS NULL OR length(explanation) <= 400),
  provider            text CHECK (provider IS NULL OR length(provider) <= 80),
  model               text CHECK (model IS NULL OR length(model) <= 120),
  task_id             text,
  session_id          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, memory_space_id, situation_id, input_digest),
  CONSTRAINT situation_assessments_situation_scope_fk
    FOREIGN KEY (situation_id, tenant_id, memory_space_id)
    REFERENCES situations (situation_id, tenant_id, memory_space_id) ON DELETE CASCADE
);

-- Rettigheter (minste privilegium per tabell) og RLS som resten av situasjonsmotoren (056).
GRANT SELECT, INSERT, UPDATE, DELETE ON situation_subscriptions TO jarvis_app;
GRANT SELECT, INSERT, DELETE ON situation_signal_log TO jarvis_app;
GRANT SELECT, INSERT, DELETE ON situation_feedback TO jarvis_app;
GRANT UPDATE (consumed_at) ON situation_feedback TO jarvis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON situation_rule_tuning TO jarvis_app;
GRANT SELECT, INSERT, DELETE ON situation_assessments TO jarvis_app;

ALTER TABLE situation_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_subscriptions_tenant ON situation_subscriptions
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_subscriptions_space ON situation_subscriptions AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE situation_signal_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_signal_log FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_signal_log_tenant ON situation_signal_log
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_signal_log_space ON situation_signal_log AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE situation_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_feedback_tenant ON situation_feedback
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_feedback_space ON situation_feedback AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE situation_rule_tuning ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_rule_tuning FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_rule_tuning_tenant ON situation_rule_tuning
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_rule_tuning_space ON situation_rule_tuning AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE situation_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE situation_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY situation_assessments_tenant ON situation_assessments
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY situation_assessments_space ON situation_assessments AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
