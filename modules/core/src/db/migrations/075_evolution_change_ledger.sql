-- D-408 (EV-0, Evolution Masterplan v1.2 kap. 6 «Change ledger»): append-only endringsregister med hash-kjede.
-- Hver selvendring (forslag, godkjenning, avvisning, blokkering, merge, deploy, rollback) får en rad som kan spores til evidens, gren,
-- commit, tester, reviewer og deploy. Registeret er GLOBALT (som `self_modification_requests`, 060): selvendring er en eier-handling over
-- den delte kodebasen, ikke en tenant-eid ressurs - derfor ingen `tenant_id`/RLS (se unntakslisten i remediation-2-schema-invariants).
--
-- Integritet i databasen selv (ikke bare i appkoden):
--   * UPDATE/DELETE/TRUNCATE forbudt (trigger) og jarvis_app har kun SELECT + INSERT.
--   * `seq` og `entry_hash` settes av en BEFORE INSERT-trigger under en advisory-lås, så kallere ikke kan velge rekkefølge eller hash,
--     og to samtidige innsettinger gir en entydig kjede. `entry_hash` = sha256(prev_hash, seq, ...felt, at) - se `ledger_entry_hash`.
--   * En E3-endring (forbudt for Evolution Engine) kan aldri registreres som godkjent/merget/deployet (CHECK).
--   * `evolution_ledger_verify()` regner kjeden på nytt og returnerer første ødelagte `seq` (NULL = hel kjede).
-- Avgrensning (NOT VERIFIED): hash-kjeden beviser at historikken ikke er endret UNDER hodet, men en databaseadministrator med tilgang
-- til triggerne kan fortsatt skrive om hele kjeden. Eksterne signerte sjekkpunkter (MC D-MC-31) er neste slice.

CREATE TABLE evolution_change_ledger (
  seq                 bigint PRIMARY KEY,
  change_id           text NOT NULL CHECK (length(change_id) BETWEEN 1 AND 200),
  change_class        text NOT NULL CHECK (change_class IN ('E0', 'E1', 'E2', 'E3')),
  decision            text NOT NULL CHECK (decision IN ('proposed', 'approved', 'rejected', 'blocked', 'merged', 'deployed', 'rolled_back')),
  constitution_digest text NOT NULL CHECK (constitution_digest ~ '^[0-9a-f]{64}$'),
  subject             text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
  paths               text[] NOT NULL CHECK (cardinality(paths) <= 500),
  branch              text NOT NULL CHECK (length(branch) <= 300),
  head_sha            text CHECK (head_sha IS NULL OR head_sha ~ '^[0-9a-f]{7,64}$'),
  -- kanonisk JSON (sorterte nøkler) skrevet av appen: tester, reviewer, godkjenner, deploy-referanser
  evidence            text NOT NULL CHECK (length(evidence) <= 20000 AND evidence::jsonb IS NOT NULL),
  recorded_by         text NOT NULL CHECK (length(recorded_by) BETWEEN 1 AND 200),
  at                  timestamptz NOT NULL DEFAULT now(),
  prev_hash           text NOT NULL,
  entry_hash          text NOT NULL UNIQUE,
  CONSTRAINT evolution_ledger_e3_never_executed CHECK (NOT (change_class = 'E3' AND decision IN ('approved', 'merged', 'deployed')))
);
CREATE INDEX evolution_change_ledger_change_idx ON evolution_change_ledger (change_id, seq);

-- Felles hash-formel (brukes av trigger og verifisering; speilet i TypeScript `chainHash`). Feltskille: US (0x1f), listeskille: RS (0x1e).
CREATE FUNCTION ledger_entry_hash(
  p_prev text, p_seq bigint, p_change_id text, p_class text, p_decision text, p_digest text, p_subject text,
  p_paths text[], p_branch text, p_head_sha text, p_evidence text, p_recorded_by text, p_at_text text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(sha256(convert_to(
    concat_ws(E'\x1f', p_prev, p_seq::text, p_change_id, p_class, p_decision, p_digest, p_subject,
              array_to_string(p_paths, E'\x1e'), p_branch, coalesce(p_head_sha, ''), p_evidence, p_recorded_by, p_at_text),
    'UTF8')), 'hex')
$$;

CREATE FUNCTION ledger_at_text(p_at timestamptz) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
$$;

CREATE FUNCTION evolution_ledger_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  last_seq bigint;
  last_hash text;
BEGIN
  -- Serialiser alle innsettinger: kjeden har ÉN hode, og seq/prev_hash leses og skrives under samme lås.
  PERFORM pg_advisory_xact_lock(hashtext('jarvis_evolution_change_ledger'));
  SELECT seq, entry_hash INTO last_seq, last_hash FROM evolution_change_ledger ORDER BY seq DESC LIMIT 1;
  NEW.seq := coalesce(last_seq, 0) + 1;
  NEW.prev_hash := coalesce(last_hash, repeat('0', 64));
  NEW.at := coalesce(NEW.at, now());
  NEW.entry_hash := ledger_entry_hash(
    NEW.prev_hash, NEW.seq, NEW.change_id, NEW.change_class, NEW.decision, NEW.constitution_digest, NEW.subject,
    NEW.paths, NEW.branch, NEW.head_sha, NEW.evidence, NEW.recorded_by, ledger_at_text(NEW.at));
  RETURN NEW;
END;
$$;

CREATE TRIGGER evolution_ledger_hash_chain
  BEFORE INSERT ON evolution_change_ledger
  FOR EACH ROW EXECUTE FUNCTION evolution_ledger_before_insert();

CREATE FUNCTION evolution_ledger_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'append_only_table: evolution_change_ledger tillater ikke %', TG_OP;
END;
$$;

CREATE TRIGGER evolution_ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON evolution_change_ledger
  FOR EACH ROW EXECUTE FUNCTION evolution_ledger_forbid_mutation();
CREATE TRIGGER evolution_ledger_no_truncate
  BEFORE TRUNCATE ON evolution_change_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION evolution_ledger_forbid_mutation();

-- Regner kjeden på nytt. Returnerer første `seq` der kjeden er ødelagt (feil prev_hash, feil hash eller hull), ellers NULL.
CREATE FUNCTION evolution_ledger_verify() RETURNS bigint LANGUAGE plpgsql STABLE AS $$
DECLARE
  r record;
  expected_prev text := repeat('0', 64);
  expected_seq bigint := 1;
BEGIN
  FOR r IN SELECT * FROM evolution_change_ledger ORDER BY seq LOOP
    IF r.seq <> expected_seq OR r.prev_hash <> expected_prev OR r.entry_hash <> ledger_entry_hash(
         r.prev_hash, r.seq, r.change_id, r.change_class, r.decision, r.constitution_digest, r.subject,
         r.paths, r.branch, r.head_sha, r.evidence, r.recorded_by, ledger_at_text(r.at)) THEN
      RETURN r.seq;
    END IF;
    expected_prev := r.entry_hash;
    expected_seq := expected_seq + 1;
  END LOOP;
  RETURN NULL;
END;
$$;

GRANT SELECT, INSERT ON evolution_change_ledger TO jarvis_app;
GRANT EXECUTE ON FUNCTION evolution_ledger_verify() TO jarvis_app;
