-- UA-3 next slice (D-53): automatisk open-loop-deteksjon over Business Graph.
-- Additiv migrasjon PA P0-skjemaet (019_business.sql) - ingen eksisterende
-- business_*-tabell endres. Samme RLS-monster som business_followups.
-- detection_key er den deterministiske idempotens-noekkelen ETT loop-forhold
-- mappes til (f.eks. 'overdue_followup:<followup_id>') - re-kjoert deteksjon
-- oppdaterer SAMME rad, oppretter aldri en duplikat.

CREATE TABLE business_open_loops (
  open_loop_id          text PRIMARY KEY,
  tenant_id              text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id        text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id             text REFERENCES business_companies (company_id),
  contact_id             text REFERENCES business_contacts (contact_id),
  opportunity_id         text REFERENCES business_opportunities (opportunity_id),
  lead_id                text REFERENCES business_leads (lead_id),
  followup_id            text REFERENCES business_followups (followup_id),
  activity_id            text REFERENCES business_activities (activity_id),
  loop_type              text NOT NULL CHECK (loop_type IN ('overdue_followup', 'stalled_opportunity')),
  -- Idempotent deteksjon (samme monster som business_activities/business_leads sin
  -- UNIQUE-basert ingestion): re-evaluering av SAMME forhold oppdaterer denne raden.
  detection_key          text NOT NULL,
  detection_method       text NOT NULL DEFAULT 'deterministic' CHECK (detection_method IN ('deterministic', 'ai_assisted')),
  confidence             numeric,
  reason                 text NOT NULL,
  next_action            text,
  -- Loes peker til Knowledge/ekstern kilde (ALDRI kopi av fullt innhold - samme
  -- prinsipp som business_activities.canonical_uri).
  canonical_uri          text,
  priority                text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status                 text NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  owner_person_id        text REFERENCES people (person_id),
  opened_at              timestamptz NOT NULL DEFAULT now(),
  due_at                 timestamptz,
  resolved_at            timestamptz,
  resolution_reason      text,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, detection_key)
);
CREATE INDEX business_open_loops_attention_idx ON business_open_loops (tenant_id, memory_space_id, status, priority, due_at);

GRANT SELECT, INSERT, UPDATE ON business_open_loops TO jarvis_app;

ALTER TABLE business_open_loops ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_open_loops FORCE ROW LEVEL SECURITY;
CREATE POLICY business_open_loops_tenant ON business_open_loops
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY business_open_loops_space ON business_open_loops AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
