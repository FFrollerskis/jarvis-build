-- WP-F1 (D-462, Q-47 a / UA-6 akseptanse «intent -> provider-forespørsel -> utfall -> regnskap/avstemming»): deterministisk avstemming av penger.
--
-- `finance_reconciliation_runs`: én rad per avstemmingskjøring (planlagt sveip eller på forespørsel) med status per sjekk (`ok` / `skipped_no_credentials` /
-- `incomplete` / `failed:<kode>`) - slik at «dormant uten credentials» er SYNLIG i stedet for en stille grønn. `finance_reconciliation_findings`: funn som
-- sammenholder intensjoner <-> leverandørutfall <-> Fiken-bilag (manglende / ekstra / uoverensstemmende beløp, ukjent utfall, dobbeltbetaling mistenkt,
-- avviste hendelser). Funnene er OBSERVASJONER: ingen automatisk korreksjon, ingen ny pengehandling - de varsles og kan kun lukkes ved at betingelsen
-- ikke lenger er sann (neste kjøring) eller at eieren rydder opp i kilden. `finding_key` (kind + subjekt) gjør kjøringene idempotente: samme funn
-- oppdateres (aldri duplisert), et løst funn som dukker opp igjen gjenåpnes (`reopen_count`).
--
-- Innholdet er REDIGERT ved konstruksjon (beløp/valuta/id-er/tilstander - aldri kontonummer, KID, kortdata eller råe leverandørnyttelaster).
-- Samme RLS-/GRANT-/erasure-mønster som `038_finance.sql` (tenant-policy + RESTRICTIVE space-policy; registrert i erasure-planen).

CREATE TABLE finance_reconciliation_runs (
  run_id            text PRIMARY KEY,
  tenant_id         text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id   text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  status            text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  trigger           text NOT NULL DEFAULT 'sweep' CHECK (trigger IN ('sweep', 'manual')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  -- {sjekknavn: 'ok' | 'skipped_no_credentials' | 'incomplete' | 'failed:<kode>'}
  checks            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- tellere: {findings_open, findings_new, findings_reopened, findings_resolved, notified}
  summary           jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_message     text,
  -- Q-44 (JARVIS-076): mål for tenant-skopede komposittnøkler (tenant_id, run_id) fra funn-tabellen.
  UNIQUE (tenant_id, run_id)
);
CREATE INDEX finance_reconciliation_runs_latest_idx ON finance_reconciliation_runs (tenant_id, memory_space_id, started_at DESC);

CREATE TABLE finance_reconciliation_findings (
  finding_id         text PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants (tenant_id),
  memory_space_id    text NOT NULL DEFAULT 'business' CHECK (memory_space_id IN ('personal','business','project','health','home','guest','shared')),
  -- Deterministisk dedupe-nøkkel: `<kind>:<subject_type>:<subject_id>` (pluss ev. diskriminator for flere funn av samme art på samme subjekt).
  finding_key        text NOT NULL,
  kind               text NOT NULL CHECK (kind ~ '^[a-z0-9_]{1,60}$'),
  severity           text NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  subject_type       text NOT NULL CHECK (subject_type ~ '^[a-z0-9_]{1,40}$'),
  subject_id         text NOT NULL CHECK (length(subject_id) BETWEEN 1 AND 300),
  payment_intent_id  text,
  summary            text NOT NULL CHECK (length(summary) <= 500),
  expected           jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed           jsonb NOT NULL DEFAULT '{}'::jsonb,
  status             text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  first_seen_run_id  text,
  last_seen_run_id   text,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at        timestamptz,
  reopen_count       integer NOT NULL DEFAULT 0,
  UNIQUE (tenant_id, finding_key),
  -- Q-44 (JARVIS-076): alle fremmednøkler er (tenant_id, id)-komposittnøkler - et funn kan aldri peke på en ANNEN tenants intensjon eller kjøring (FK-kontrollen går utenom RLS).
  FOREIGN KEY (tenant_id, payment_intent_id) REFERENCES payment_intents (tenant_id, payment_intent_id),
  FOREIGN KEY (tenant_id, first_seen_run_id) REFERENCES finance_reconciliation_runs (tenant_id, run_id),
  FOREIGN KEY (tenant_id, last_seen_run_id) REFERENCES finance_reconciliation_runs (tenant_id, run_id)
);
CREATE INDEX finance_reconciliation_findings_open_idx ON finance_reconciliation_findings (tenant_id, memory_space_id, severity, last_seen_at DESC) WHERE status = 'open';
CREATE INDEX finance_reconciliation_findings_intent_idx ON finance_reconciliation_findings (tenant_id, payment_intent_id) WHERE payment_intent_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON finance_reconciliation_runs, finance_reconciliation_findings TO jarvis_app;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['finance_reconciliation_runs', 'finance_reconciliation_findings'] LOOP
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
