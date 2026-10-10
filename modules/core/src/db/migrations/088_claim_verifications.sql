-- WP-D1 (UA-2, Q-26 / D-63): Knowledge Verification / Truth Promotion - KUN logikk og tabeller. Ingen autonom nettsøk, ingen automatisk promotering.
--
-- Invarianten (OPEN_QUESTIONS Q-26): tilstandsmaskin UNKNOWN -> RESEARCHING -> PROVISIONAL -> VERIFIED | DISPUTED. Permanent kunnskap krever FLERE UAVHENGIGE kilder (tre kopier av samme oppstrøms-påstand
-- teller ALDRI som tre uavhengige kilder), helst primærkilder, motstrid-/adversarial søk, ferskhet, proveniens, konfidens og re-verifiseringsfrist for tidssensitive fakta. Ukjent blir aldri stille sannhet.
--
-- Tabellene HOLDER tilstanden; reglene (hvem som teller som uavhengig, når VERIFIED er oppnådd, hvilke overganger som er lov) bor i ren kode (`modules/knowledge/src/claim-verification.ts`) og er testet uten
-- database. Databasen håndhever det den kan: gyldige statusverdier, ett evidensrad per (påstand, kilde, holdning), og space-bevisste nøkler.
--
-- Promotering til etablert kunnskap/minne skjer KUN som et FORSLAG gjennom karantene-/godkjenningsveien for minne (`memory.propose`, D-367): `promotion_*` sporer forslaget, aldri en direkte skriving.
CREATE TABLE claim_verifications (
  claim_id                 text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id          text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  claim_text               text NOT NULL CHECK (length(claim_text) BETWEEN 3 AND 1000),
  -- sha256 av normalisert tekst (NFKC, små bokstaver, sammenslåtte blanke tegn): samme påstand = samme rad, og oppslag på tekst.
  claim_hash               text NOT NULL,
  status                   text NOT NULL DEFAULT 'UNKNOWN' CHECK (status IN ('UNKNOWN','RESEARCHING','PROVISIONAL','VERIFIED','DISPUTED')),
  time_sensitive           boolean NOT NULL DEFAULT false,
  -- N uavhengige kilder for VERIFIED (standard 2; aldri under 2 - én kilde kan aldri verifisere, og «uavhengig» er hele poenget).
  min_independent_sources  integer NOT NULL DEFAULT 2 CHECK (min_independent_sources BETWEEN 2 AND 10),
  -- Utledet av evidensen ved hver endring (informativt; konfidens er ALDRI en port, kun statusen er det).
  confidence               numeric(4,3) NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  independent_support      integer NOT NULL DEFAULT 0 CHECK (independent_support >= 0),
  has_primary_support      boolean NOT NULL DEFAULT false,
  contradicting_count      integer NOT NULL DEFAULT 0 CHECK (contradicting_count >= 0),
  -- Strukturert merke (som minneelementer/kunnskapstreff): påstanden kan være helse/økonomi og skal da aldri til en skymodell.
  sensitivity              text NOT NULL DEFAULT 'sensitive' CHECK (sensitivity IN ('normal','sensitive','special')),
  researching_since        timestamptz,
  verified_at              timestamptz,
  -- Re-verifiseringsfrist for tidssensitive fakta: er fristen passert, regnes en VERIFIED påstand IKKE lenger som verifisert (lesing viser PROVISIONAL + reverification_due).
  reverify_by              timestamptz,
  promotion_status         text NOT NULL DEFAULT 'none' CHECK (promotion_status IN ('none','proposed')),
  promotion_memory_item_id text,
  promotion_proposed_at    timestamptz,
  created_by_person_id     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, memory_space_id, claim_hash),
  UNIQUE (tenant_id, memory_space_id, claim_id)
);

CREATE TABLE claim_evidence (
  evidence_id        text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id    text NOT NULL CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  claim_id           text NOT NULL,
  stance             text NOT NULL CHECK (stance IN ('supports','contradicts')),
  -- Proveniens: kilden evidensen kommer fra (URL eller dokument-id) - aldri modellgenerert.
  source_ref         text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 500),
  -- Valgfri løs peker til et kunnskapsdokument evidensen er hentet fra (ingen FK: evidensen skal overleve at dokumentet tombstones/slettes).
  knowledge_document_id text,
  -- UAVHENGIGHETSNØKKEL: opprinnelig oppstrøms-kilde/domene. Samme nøkkel = ÉN uavhengig kilde, uansett hvor mange kopier/gjengivelser.
  independence_key   text NOT NULL CHECK (length(independence_key) BETWEEN 1 AND 200),
  upstream_origin    text CHECK (upstream_origin IS NULL OR length(upstream_origin) BETWEEN 1 AND 200),
  is_primary         boolean NOT NULL DEFAULT false,
  -- Ferskhet: når kilden selv publiserte/oppdaterte (kan mangle) og når Jarvis hentet den.
  published_at       timestamptz,
  retrieved_at       timestamptz NOT NULL,
  excerpt            text CHECK (excerpt IS NULL OR length(excerpt) <= 500),
  -- Trukket tilbake av eieren (med grunn) - teller ikke lenger, men raden beholdes for sporbarhet.
  retracted          boolean NOT NULL DEFAULT false,
  retraction_reason  text CHECK (retraction_reason IS NULL OR length(retraction_reason) <= 300),
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (claim_id, source_ref, stance),
  FOREIGN KEY (tenant_id, memory_space_id, claim_id)
    REFERENCES claim_verifications (tenant_id, memory_space_id, claim_id) ON DELETE CASCADE
);
CREATE INDEX claim_evidence_claim_idx ON claim_evidence (tenant_id, memory_space_id, claim_id);
CREATE INDEX claim_verifications_status_idx ON claim_verifications (tenant_id, memory_space_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON claim_verifications, claim_evidence TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['claim_verifications', 'claim_evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I_tenant ON %I
         USING (tenant_id = current_setting(''jarvis.tenant_id'', true))
         WITH CHECK (tenant_id = current_setting(''jarvis.tenant_id'', true))', t, t);
    EXECUTE format(
      'CREATE POLICY %I_space ON %I AS RESTRICTIVE
         USING (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))
         WITH CHECK (memory_space_id = ANY (string_to_array(current_setting(''jarvis.memory_spaces'', true), '','')))', t, t);
  END LOOP;
END
$$;
