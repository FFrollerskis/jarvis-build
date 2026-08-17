-- UA-3 P0 (Business Domain Foundation): forretnings-graf-fundament for Business
-- Operating System - selskap/kontakt/lead/opportunity/aktivitet/oppfoelging.
-- Samme RLS-monster som knowledge_documents (017_knowledge.sql): tenant_id OG
-- memory_space_id haandheves i databasen, ikke bare i applikasjonskoden.
-- Multi-tenant/multi-selskap krever INGEN skjemaendring her (D-21/TENANT_MODEL.md
-- §3): hver bedrift er allerede en egen rad i `tenants` - disse tabellene er bare
-- tenant-scoped som alt annet.

CREATE TABLE business_companies (
  company_id            text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  name                  text NOT NULL,
  domain                text,
  status                text NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect','active','inactive','churned')),
  source                text,
  owner_person_id       text REFERENCES people (person_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_companies_lookup_idx ON business_companies (tenant_id, memory_space_id);

CREATE TABLE business_contacts (
  contact_id            text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id            text REFERENCES business_companies (company_id),
  name                  text NOT NULL,
  email                 text,
  phone                 text,
  title                 text,
  source                text,
  owner_person_id       text REFERENCES people (person_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_contacts_lookup_idx ON business_contacts (tenant_id, memory_space_id, company_id);

CREATE TABLE business_leads (
  lead_id               text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id            text REFERENCES business_companies (company_id),
  contact_id            text REFERENCES business_contacts (contact_id),
  title                 text NOT NULL,
  status                text NOT NULL DEFAULT 'new' CHECK (status IN ('new','contacted','qualified','disqualified','converted')),
  source                text,
  source_type           text,
  source_instance_id    text,
  external_id           text,
  owner_person_id       text REFERENCES people (person_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Idempotent ingestion (§22 i BO-en): samme eksterne kilde-hendelse -> samme rad, aldri duplisert.
  UNIQUE (tenant_id, source_type, source_instance_id, external_id)
);
CREATE INDEX business_leads_lookup_idx ON business_leads (tenant_id, memory_space_id, status);

CREATE TABLE business_opportunities (
  opportunity_id        text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id            text REFERENCES business_companies (company_id),
  contact_id            text REFERENCES business_contacts (contact_id),
  lead_id               text REFERENCES business_leads (lead_id),
  title                 text NOT NULL,
  stage                 text NOT NULL DEFAULT 'new' CHECK (stage IN ('new','qualified','proposal','negotiation','won','lost')),
  value_ore             integer,
  currency              text NOT NULL DEFAULT 'NOK',
  expected_close_date   date,
  owner_person_id       text REFERENCES people (person_id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX business_opportunities_lookup_idx ON business_opportunities (tenant_id, memory_space_id, stage);

CREATE TABLE business_activities (
  activity_id           text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id            text REFERENCES business_companies (company_id),
  contact_id            text REFERENCES business_contacts (contact_id),
  opportunity_id        text REFERENCES business_opportunities (opportunity_id),
  lead_id               text REFERENCES business_leads (lead_id),
  activity_type         text NOT NULL CHECK (activity_type IN ('email','call','meeting','note','status_change','task','document','external_event')),
  summary               text NOT NULL,
  -- Peker til Knowledge/kilde - ALDRI kopi av full innhold (§15 i BO-en).
  source_type           text,
  source_instance_id    text,
  external_id           text,
  canonical_uri         text,
  owner_person_id       text REFERENCES people (person_id),
  occurred_at           timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  -- Idempotent aktivitets-ingestion (§22): samme eksterne hendelse kan trygt re-prosesseres.
  UNIQUE (tenant_id, source_type, source_instance_id, external_id)
);
CREATE INDEX business_activities_timeline_idx ON business_activities (tenant_id, company_id, occurred_at DESC);
CREATE INDEX business_activities_contact_timeline_idx ON business_activities (tenant_id, contact_id, occurred_at DESC);

CREATE TABLE business_followups (
  followup_id           text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  company_id            text REFERENCES business_companies (company_id),
  contact_id            text REFERENCES business_contacts (contact_id),
  opportunity_id        text REFERENCES business_opportunities (opportunity_id),
  lead_id               text REFERENCES business_leads (lead_id),
  activity_id           text REFERENCES business_activities (activity_id),
  title                 text NOT NULL,
  reason                text,
  next_action           text,
  due_at                timestamptz NOT NULL,
  priority               text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  status                text NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
  owner_person_id       text REFERENCES people (person_id),
  completed_at          timestamptz,
  cancelled_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  -- Idempotent oppfoelging-opprettelse (§22): dupliserte agent-kjøringer skal aldri gi doble oppgaver.
  idempotency_key       text,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX business_followups_overdue_idx ON business_followups (tenant_id, memory_space_id, status, due_at);

GRANT SELECT, INSERT, UPDATE ON
  business_companies, business_contacts, business_leads,
  business_opportunities, business_activities, business_followups
  TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'business_companies', 'business_contacts', 'business_leads',
    'business_opportunities', 'business_activities', 'business_followups'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    -- AS RESTRICTIVE: AND-es med tenant-policyen (default deny uten gyldig space-kontekst,
    -- identisk prinsipp til knowledge_documents sin space-RESTRICTIVE-policy).
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
