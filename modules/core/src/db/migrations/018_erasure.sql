-- Q-20: teknisk data-erasure-foundation (docs/DATA_ERASURE.md). To ledger-tabeller:
-- erasure_requests (trygt kvitteringslager - kun identifiers/counts, ALDRI innhold) og
-- erasure_fingerprints (resurrection-suppression for knowledge-sync - kun irreversible
-- fingerprints, ALDRI raw external_id/innhold). Samme RLS-mønster som resten av systemet.

CREATE TABLE erasure_requests (
  request_id     text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants (tenant_id),
  scope_type     text NOT NULL CHECK (scope_type IN
                    ('tenant', 'person', 'memory_space', 'knowledge_source', 'knowledge_document', 'conversation')),
  -- KUN identifiers som allerede var kjent FØR sletting (adressen, ikke innholdet) - se docs/DATA_ERASURE.md §6.
  scope_summary  jsonb NOT NULL,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed')),
  record_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_person_id text,
  actor_device_id text,
  -- Trygg, trunkert feilmelding - aldri payload/innhold.
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX erasure_requests_tenant_idx ON erasure_requests (tenant_id, started_at);

CREATE TABLE erasure_fingerprints (
  fingerprint        text NOT NULL,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  source_type        text NOT NULL,
  source_instance_id text NOT NULL,
  erasure_request_id text NOT NULL REFERENCES erasure_requests (request_id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fingerprint)
);
CREATE INDEX erasure_fingerprints_source_idx ON erasure_fingerprints (tenant_id, source_type, source_instance_id);

GRANT SELECT, INSERT, UPDATE ON erasure_requests, erasure_fingerprints TO jarvis_app;

-- Q-20 er den FØRSTE og ENESTE hard-delete-veien i systemet: inntil nå hadde
-- jarvis_app KUN SELECT/INSERT/UPDATE (all "sletting" var myk - tombstone-
-- flagg). Dette er en bevisst, eksplisitt utvidelse av jarvis_app sine
-- rettigheter, begrenset til NØYAKTIG de tabellene ErasureService faktisk
-- hard-sletter fra (docs/DATA_ERASURE.md §2 klasse A/B) - ALDRI events/
-- audit_events (append-only, se §2 klasse D - forblir uten DELETE-rettighet
-- i tillegg til å være trigger-blokkert), ALDRI capabilities/approvals/
-- cost_events (operasjonell metadata, klasse C - ingen sletteveier bygget).
GRANT DELETE ON
  messages, sessions, memory_items, memory_versions, entities, relations,
  memory_item_entities, summaries, embeddings, decisions, commitments, deadlines,
  knowledge_documents, knowledge_embeddings, artifacts
TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['erasure_requests', 'erasure_fingerprints'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
  END LOOP;
END
$$;
