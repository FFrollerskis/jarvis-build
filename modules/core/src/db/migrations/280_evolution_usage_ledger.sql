-- WP-EV0 (HF2 EV-0, kap. 6 og kap. 29): append-only FORBRUKS- og EIER-TID-register med hash-kjede.
-- Budsjettlåsene (`BudgetLock`) teller herfra - aldri fra Evolution selv: kostnad pr. kategori (radar, eval, redteam, shadow, review) i ØRE og eierens tid
-- (godkjenninger, merking, review, styring) i MINUTTER, hver rad knyttet til målingen den kommer fra (`source_ref`, f.eks. `cost_events:<id>`) og til konstitusjonen som gjaldt.
-- Raden skrives av deterministisk målekode (modellgateway-kostnadsføring, eier-konsollen) - ikke av motoren; `recorded_by` sier hvem. Tallene i signert manifest
-- (`budget_caps`) er takene; denne tabellen er forbruket. PROJECT_STATUS-blokken er en GENERERT visning av begge (ops/evolution/project-status-block.ts).
--
-- Mønster = endringsregisteret (075, D-408): GLOBALT (ingen `tenant_id`/RLS: Evolution er en eier-handling over den delte kodebasen og forbruket er plattform-metadata
-- uten personopplysninger - se unntakslisten i remediation-2-schema-invariants), og integriteten ligger i databasen selv:
--   * UPDATE/DELETE/TRUNCATE forbudt (trigger) og jarvis_app har kun SELECT + INSERT.
--   * `seq` og `entry_hash` settes av en BEFORE INSERT-trigger under en egen advisory-lås, så kallere ikke kan velge rekkefølge eller hash.
--   * CHECK-regler hindrer meningsløse rader selv ved rå INSERT: kategori må høre til typen, beløp > 0, godkjenning/review må knyttes til en endring, og
--     `source_ref`/`recorded_by` er begrenset til et trygt tegnsett (ingen fritekst, aldri hemmeligheter).
--   * `evolution_usage_ledger_verify()` regner kjeden på nytt og returnerer første ødelagte `seq` (NULL = hel kjede).
-- Avgrensning (NOT VERIFIED): en databaseadministrator med tilgang til triggerne kan skrive om hele kjeden (som 075); eksterne signerte sjekkpunkter er neste slice.
-- Klassifisering (MC8a-regelen finnes ikke i basen; mønsteret er 075): operasjonell metadata uten personopplysninger (kun kategori, beløp, endrings-ID, målereferanse, digest).
-- Tabellen står i docs/security/PROCESSING_INVENTORY.md (guard-testen d420 krever en rad pr. tabell) og i unntakslisten for tabeller uten RLS; ingen erasure-plan trengs
-- fordi ingen rad kan peke på en person.
-- Rollback: tabellen er rent additiv (expand); ingen eksisterende kode leser den. Forover-only: fjern bruken i koden og la tabellen stå (append-only), ikke DROP.

CREATE TABLE evolution_usage_ledger (
  seq                 bigint PRIMARY KEY,
  kind                text NOT NULL CHECK (kind IN ('spend', 'owner_time')),
  -- spend: radar | eval | redteam | shadow | review. owner_time: approval | label | review | governance.
  category            text NOT NULL,
  -- spend: øre. owner_time: minutter. Alltid > 0 (en måling uten forbruk er ingen rad); øvre grense er kun et overløpsvern.
  amount              bigint NOT NULL CHECK (amount BETWEEN 1 AND 1000000000),
  change_id           text CHECK (change_id IS NULL OR length(change_id) BETWEEN 1 AND 200),
  -- (Postgres-regex tillater maks 255 i {n,m}: lengden sjekkes separat)
  source_ref          text NOT NULL CHECK (length(source_ref) BETWEEN 1 AND 300 AND source_ref ~ '^[A-Za-z0-9_.:/#-]+$'),
  constitution_digest text NOT NULL CHECK (constitution_digest ~ '^[0-9a-f]{64}$'),
  recorded_by         text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200 AND recorded_by ~ '^[A-Za-z0-9_.:/#-]+$'),
  at                  timestamptz NOT NULL DEFAULT now(),
  prev_hash           text NOT NULL,
  entry_hash          text NOT NULL UNIQUE,
  CONSTRAINT evolution_usage_kind_category CHECK (
    (kind = 'spend' AND category IN ('radar', 'eval', 'redteam', 'shadow', 'review'))
    OR (kind = 'owner_time' AND category IN ('approval', 'label', 'review', 'governance'))
  ),
  -- Eier-tid pr. autonom endring kan bare regnes hvis godkjenning/review er knyttet til endringen.
  CONSTRAINT evolution_usage_owner_work_needs_change CHECK (NOT (kind = 'owner_time' AND category IN ('approval', 'review') AND change_id IS NULL))
);
CREATE INDEX evolution_usage_ledger_window_idx ON evolution_usage_ledger (kind, category, at);
CREATE INDEX evolution_usage_ledger_change_idx ON evolution_usage_ledger (change_id, kind) WHERE change_id IS NOT NULL;

-- Hash-formel (speilet i TypeScript `usageChainHash`). Feltskille: US (0x1f). Gjenbruker 075s `ledger_at_text` for tidsstempelet.
CREATE FUNCTION usage_ledger_entry_hash(
  p_prev text, p_seq bigint, p_kind text, p_category text, p_amount bigint, p_change_id text, p_source_ref text, p_digest text, p_recorded_by text, p_at_text text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    concat_ws(E'\x1f', p_prev, p_seq::text, p_kind, p_category, p_amount::text, coalesce(p_change_id, ''), p_source_ref, p_digest, p_recorded_by, p_at_text),
    'UTF8')), 'hex')
$$;

CREATE FUNCTION evolution_usage_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  -- Serialiser alle innsettinger: kjeden har ÉN hode, og seq/prev_hash leses og skrives under samme lås.
  PERFORM pg_advisory_xact_lock(hashtext('jarvis_evolution_usage_ledger'));
  SELECT seq, entry_hash INTO last_seq, last_hash FROM evolution_usage_ledger ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.at := coalesce(NEW.at, now());
  NEW.entry_hash := usage_ledger_entry_hash(
    NEW.prev_hash, NEW.seq, NEW.kind, NEW.category, NEW.amount, NEW.change_id, NEW.source_ref, NEW.constitution_digest, NEW.recorded_by, ledger_at_text(NEW.at));
  RETURN NEW;
END;
$$;

CREATE TRIGGER evolution_usage_hash_chain
  BEFORE INSERT ON evolution_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION evolution_usage_before_insert();

CREATE FUNCTION evolution_usage_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: evolution_usage_ledger tillater ikke %', TG_OP;
END;
$$;

CREATE TRIGGER evolution_usage_no_update_delete
  BEFORE UPDATE OR DELETE ON evolution_usage_ledger
  FOR EACH ROW EXECUTE FUNCTION evolution_usage_forbid_mutation();
CREATE TRIGGER evolution_usage_no_truncate
  BEFORE TRUNCATE ON evolution_usage_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION evolution_usage_forbid_mutation();

-- Regner kjeden på nytt. Returnerer første `seq` der kjeden er ødelagt (feil prev_hash, feil hash eller hull), ellers NULL.
CREATE FUNCTION evolution_usage_ledger_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM evolution_usage_ledger ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> expected_prev OR r.entry_hash <> usage_ledger_entry_hash(
         r.prev_hash, r.seq, r.kind, r.category, r.amount, r.change_id, r.source_ref, r.constitution_digest, r.recorded_by, ledger_at_text(r.at)) THEN
      RETURN r.seq;
    END IF;
    expected_prev := r.entry_hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

GRANT SELECT, INSERT ON evolution_usage_ledger TO jarvis_app;
GRANT EXECUTE ON FUNCTION evolution_usage_ledger_verify() TO jarvis_app;
