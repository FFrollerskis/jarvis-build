-- UA-3 profiling/scoring slice (D-61, akseptansekriterium 4): transparent
-- BUSINESS-OPERASJONELL prioritering/risiko-scoring over lead/opportunity -
-- ALDRI generalisert personprofilering. Additiv migrasjon PA P0/open-loop-
-- skjemaet (019/020_business*.sql) - ingen eksisterende business_*-tabell
-- endres. Samme RLS-monster som business_open_loops.
--
-- entity_type er BEVISST begrenset til 'lead'/'opportunity' (§11 i
-- byggeordren: "Prefer scoring business_leads, business_opportunities...
-- rather than generalized scoring of individual humans") - INGEN
-- kontakt-/person-scoring-rad kan noensinne opprettes i dette skjemaet.
--
-- factor_summary/evidence er jsonb (array) - strukturerte, transparente
-- faktor-koder + kilde-referanser (aktivitet-/open-loop-ID-er), ALDRI kopiert
-- kildeinnhold (samme prinsipp som business_activities.canonical_uri/
-- business_open_loops.canonical_uri - los peker, ikke kopi).
--
-- UNIQUE (tenant_id, entity_type, entity_id, score_type) gir idempotent
-- rekalkulering - re-kjoering av samme regel for samme entitet oppdaterer
-- SAMME rad, oppretter aldri en duplikat (samme monster som
-- business_open_loops sin detection_key-UNIQUE).

CREATE TABLE business_scores (
  score_id              text PRIMARY KEY,
  tenant_id             text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id       text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  entity_type           text NOT NULL CHECK (entity_type IN ('lead','opportunity')),
  entity_id             text NOT NULL,
  score_type            text NOT NULL CHECK (score_type IN ('lead_priority','opportunity_risk')),
  rule_version           text NOT NULL,
  detection_method       text NOT NULL DEFAULT 'deterministic' CHECK (detection_method IN ('deterministic', 'ai_assisted')),
  score                  numeric NOT NULL CHECK (score >= 0 AND score <= 100),
  -- [{code, label, weight, contribution}, ...] - transparent, deterministisk begrunnelse.
  factor_summary          jsonb NOT NULL,
  -- [{type: 'activity'|'followup'|'open_loop', id}, ...] - los kilde-referanse, ALDRI kopiert innhold.
  evidence                jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- §9/§18 i byggeordren: eier-autorisert manuell overstyring. En overstyring er ALDRI
  -- tillatelse til aa forfalske underliggende kildedata - kun en separat, eksplisitt
  -- markert visnings-/prioriterings-verdi ved siden av den beregnede scoren.
  manual_override         boolean NOT NULL DEFAULT false,
  override_score          numeric CHECK (override_score IS NULL OR (override_score >= 0 AND override_score <= 100)),
  override_reason         text,
  override_by             text REFERENCES people (person_id),
  override_at             timestamptz,
  calculated_at           timestamptz NOT NULL DEFAULT now(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, entity_id, score_type)
);
CREATE INDEX business_scores_rank_idx ON business_scores (tenant_id, memory_space_id, entity_type, score_type, score DESC);

GRANT SELECT, INSERT, UPDATE ON business_scores TO jarvis_app;

ALTER TABLE business_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_scores FORCE ROW LEVEL SECURITY;
CREATE POLICY business_scores_tenant ON business_scores
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));
CREATE POLICY business_scores_space ON business_scores AS RESTRICTIVE
  USING (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')))
  WITH CHECK (memory_space_id = ANY (string_to_array(current_setting('jarvis.memory_spaces', true), ',')));
