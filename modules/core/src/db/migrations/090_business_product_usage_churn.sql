-- WP-D2 (UA-3 Business OS, mandat D-450): kilder for produktbruk og deterministiske churn-signaler («churn/product usage», UA-gap-audit 2026-10-05).
-- Additiv migrasjon - ingen eksisterende kolonne endres; kun loop_type-CHECK-en på business_open_loops utvides med EN verdi.
--
-- PERSONVERN (UA3_BUSINESS_DPIA.md «Produktbruk og churn»): en hendelse bærer KUN pseudonyme referanser (`account_ref`, `user_ref` - avsenderen hasher selv),
-- en funksjonsnøkkel, et tidspunkt og et antall. Ingen navn, e-post, telefon, IP eller fritekst har en kolonne å havne i, og referansene har en CHECK som avviser
-- e-post (@), mellomrom, rene 8-15-sifrede tall (telefon-/fødselsnummerlignende) og IPv4-adresser - også hvis appkoden skulle feile (forsvar i dybden).
-- Hendelsene brukes UTELUKKENDE til intern forretningsprioritering på kundenivå (konto -> selskap), aldri til person-profilering: `user_ref` leses av ingen churn-regel.
--
--  1. `product_usage_accounts`: konto-referanse -> (valgfritt) kundeselskap. Koblingen er EIERENS valg (business.link_product_account / import-CLI); en ukoblet konto får
--     ingen churn-vurdering og ingen open loop (ingen kan handle på et pseudonym).
--  2. `product_usage_events`: rå hendelser. Idempotens: `UNIQUE (tenant_id, external_event_id)` - avsenderens egen hendelses-id, uavhengig av kilde (webhook, JSONL, CSV),
--     slik at en gjentatt levering eller en overlappende import aldri teller samme hendelse to ganger. Uforanderlig for runtime (kun SELECT/INSERT); DELETE er gitt
--     for oppbevaringssveipet og Q-20-erasure, og UPDATE KUN på `user_ref` (glem én bruker uten å endre kontoens volum).
--  3. `business_churn_assessments`: siste beregnede vurdering per konto (forklarbar: signaler, vekter, rå mål). Idempotent rekalkulering = samme rad oppdateres.
--  4. `business_open_loops.loop_type` får `customer_churn_risk` (SUGGEST/INFORM via situasjonsbroen - aldri ACT uten eierens eksisterende autonomi-policy for domenet).
-- Alle nye tabeller er FORCE RLS med tenant- OG memory-space-policy (samme mønster som resten av Business OS); fremmednøkler til tenant-eide tabeller er
-- tenant-skopede komposittnøkler (JARVIS-076).

CREATE TABLE product_usage_accounts (
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  account_ref      text NOT NULL,
  -- Eierens kobling til et kundeselskap. NULL = ikke koblet ennå. `linked_by`/`linked_at` følger koblingen (kun for revisjon, ingen FK: en systemaktør er gyldig).
  company_id       text,
  linked_by        text,
  linked_at        timestamptz,
  first_event_at   timestamptz,
  last_event_at    timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref),
  CONSTRAINT product_usage_accounts_ref_pseudonymous CHECK (
    account_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$'
    AND regexp_replace(account_ref, '[-_.:]', '', 'g') !~ '^[0-9]{8,19}$'
    AND account_ref !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
    AND NOT (position(':' in account_ref) > 0 AND account_ref ~ '^[0-9a-fA-F:]+$')
  ),
  CONSTRAINT product_usage_accounts_link_consistent CHECK ((company_id IS NULL) = (linked_at IS NULL))
);
ALTER TABLE product_usage_accounts
  ADD CONSTRAINT product_usage_accounts_company_tenant_fkey
  FOREIGN KEY (tenant_id, company_id) REFERENCES business_companies (tenant_id, company_id);
CREATE INDEX product_usage_accounts_company_idx ON product_usage_accounts (tenant_id, company_id) WHERE company_id IS NOT NULL;

CREATE TABLE product_usage_events (
  event_id           text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id    text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Hvor hendelsen kom fra: `webhook` eller `import:<etikett>` (kun sporing - inngår IKKE i idempotensnøkkelen).
  source_id          text NOT NULL CHECK (source_id ~ '^(webhook|import:[a-z0-9][a-z0-9_.-]{0,39})$'),
  external_event_id  text NOT NULL CHECK (external_event_id ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$'),
  kind               text NOT NULL CHECK (kind IN ('usage', 'billing_status')),
  account_ref        text NOT NULL,
  user_ref           text,
  feature            text,
  -- `usage`: antall (1-100000). `billing_status`: antall FORFALTE fakturaer på kontoen (0 = ingen).
  quantity           integer NOT NULL,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, external_event_id),
  CONSTRAINT product_usage_events_user_ref_pseudonymous CHECK (
    user_ref IS NULL OR (
      user_ref ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$'
      AND regexp_replace(user_ref, '[-_.:]', '', 'g') !~ '^[0-9]{8,19}$'
      AND user_ref !~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'
      AND NOT (position(':' in user_ref) > 0 AND user_ref ~ '^[0-9a-fA-F:]+$')
    )
  ),
  CONSTRAINT product_usage_events_shape CHECK (
    (kind = 'usage' AND feature IS NOT NULL AND feature ~ '^[a-z0-9][a-z0-9_.:-]{0,63}$' AND quantity BETWEEN 1 AND 100000)
    OR (kind = 'billing_status' AND feature IS NULL AND user_ref IS NULL AND quantity BETWEEN 0 AND 1000)
  )
);
-- Konto-FK: en hendelse kan ikke finnes uten sin konto-rad (ingest upserter kontoen først). Sletter erasure kontoen, følger hendelsene med.
ALTER TABLE product_usage_events
  ADD CONSTRAINT product_usage_events_account_tenant_fkey
  FOREIGN KEY (tenant_id, account_ref) REFERENCES product_usage_accounts (tenant_id, account_ref) ON DELETE CASCADE;
CREATE INDEX product_usage_events_account_idx ON product_usage_events (tenant_id, account_ref, kind, occurred_at DESC);
CREATE INDEX product_usage_events_time_idx ON product_usage_events (tenant_id, occurred_at);

CREATE TABLE business_churn_assessments (
  tenant_id        text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id  text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  account_ref      text NOT NULL,
  company_id       text NOT NULL,
  -- Reglene er versjonert (churn-rules.ts): endrede vekter = NY versjon, aldri en stille mutasjon - en lagret vurdering forblir forklarbar med reglene den ble beregnet med.
  rule_version     text NOT NULL,
  risk_score       numeric NOT NULL CHECK (risk_score >= 0 AND risk_score <= 100),
  risk_level       text NOT NULL CHECK (risk_level IN ('low', 'medium', 'high')),
  -- [{code, label, weight, contribution}, ...] - hvert signal som bidro, med vekt (transparent, deterministisk begrunnelse).
  signals          jsonb NOT NULL,
  -- Hvilke signalfamilier som slo ut ('usage' | 'support' | 'billing') - grunnlaget for confidence (flere uavhengige familier = høyere sikkerhet).
  signal_families  text[] NOT NULL DEFAULT '{}',
  -- Rå, aggregerte mål reglene så (dager uten bruk, volum siste/forrige 14 dager, åpne saker, forfalte fakturaer) - tall, aldri persondata.
  metrics          jsonb NOT NULL,
  -- Løse kilde-pekere (supportsak-id-er, faktura-hendelse) - ALDRI kopiert innhold.
  evidence         jsonb NOT NULL DEFAULT '[]'::jsonb,
  calculated_at    timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_ref, rule_version)
);
ALTER TABLE business_churn_assessments
  ADD CONSTRAINT business_churn_assessments_account_tenant_fkey
  FOREIGN KEY (tenant_id, account_ref) REFERENCES product_usage_accounts (tenant_id, account_ref) ON DELETE CASCADE;
ALTER TABLE business_churn_assessments
  ADD CONSTRAINT business_churn_assessments_company_tenant_fkey
  FOREIGN KEY (tenant_id, company_id) REFERENCES business_companies (tenant_id, company_id);
CREATE INDEX business_churn_assessments_rank_idx ON business_churn_assessments (tenant_id, memory_space_id, risk_score DESC);

-- RLS: tenant-policy + RESTRICTIVE space-policy (samme mønster som business_scores / business_open_loops).
ALTER TABLE product_usage_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_usage_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY product_usage_accounts_tenant ON product_usage_accounts
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY product_usage_accounts_space ON product_usage_accounts AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE product_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_usage_events FORCE ROW LEVEL SECURITY;
CREATE POLICY product_usage_events_tenant ON product_usage_events
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY product_usage_events_space ON product_usage_events AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

ALTER TABLE business_churn_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_churn_assessments FORCE ROW LEVEL SECURITY;
CREATE POLICY business_churn_assessments_tenant ON business_churn_assessments
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY business_churn_assessments_space ON business_churn_assessments AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));

-- Rettigheter. Hendelser er uforanderlige for runtime: ingen UPDATE bortsett fra kolonnen `user_ref` (glem én bruker), DELETE kun for oppbevaring (400 dager) og Q-20-erasure.
GRANT SELECT, INSERT, UPDATE, DELETE ON product_usage_accounts TO jarvis_app;
GRANT SELECT, INSERT, DELETE ON product_usage_events TO jarvis_app;
GRANT UPDATE (user_ref) ON product_usage_events TO jarvis_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON business_churn_assessments TO jarvis_app;

-- Ny loop-type. CHECK-en bygges om fra den GJELDENDE definisjonen (ikke en håndkopiert liste): andre migrasjoner/branches som også utvider listen
-- (finans, kunnskap ...) kan da ikke bli stille overskrevet uansett migrasjonsrekkefølge.
DO $$
DECLARE
  def  text;
  vals text[];
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def
    FROM pg_constraint
   WHERE conrelid = 'business_open_loops'::regclass AND conname = 'business_open_loops_loop_type_check';
  IF def IS NULL THEN
    RAISE EXCEPTION 'business_open_loops_loop_type_check finnes ikke - kan ikke utvide loop_type';
  END IF;
  SELECT array_agg(m[1]) INTO vals FROM regexp_matches(def, '''([^'']+)''::text', 'g') AS m;
  IF vals IS NULL OR array_length(vals, 1) < 20 THEN
    RAISE EXCEPTION 'uventet loop_type-CHECK (%) - avbryter i stedet for å gjette', def;
  END IF;
  IF NOT ('customer_churn_risk' = ANY (vals)) THEN
    vals := vals || 'customer_churn_risk'::text;
    ALTER TABLE business_open_loops DROP CONSTRAINT business_open_loops_loop_type_check;
    -- IN (...) gir samme kanoniske visning (ARRAY['a'::text, ...]) som de tidligere migrasjonene - slik at neste migrasjon kan bygge videre på samme måte.
    EXECUTE format(
      'ALTER TABLE business_open_loops ADD CONSTRAINT business_open_loops_loop_type_check CHECK (loop_type IN (%s))',
      (SELECT string_agg(quote_literal(v), ', ') FROM unnest(vals) AS v)
    );
  END IF;
END;
$$;
