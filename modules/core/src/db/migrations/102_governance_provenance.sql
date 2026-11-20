-- WP-H1 (UA-11 Admin Control Center, JARVIS-087 del 2): PROVENIENS på styringsjournalen (decision_log, scenarios, risks, goals, goal_key_results; migrasjon 059).
--
-- BAKGRUNN: styringsjournalen bar bare `created_by` (personen). CLAUDE.md regel 4 krever at ALT som skrives er merket med person, tenant, minnerom, KILDE og task_id/session_id - og en
-- journalpost kan være formulert av en modell som har lest ubetrodd innhold. Uten kilde-merking kunne ikke eieren se om en beslutning/risiko/mål er hennes egne ord (hurtigbanen), formulert av
-- en modell, eller opprettet av en bakgrunnsjobb - og journalen var isolert fra resten av sporbarheten (audit_events har retensjon, journalradene ikke).
--
-- NÅ: fem NULLBARE kolonner per tabell, satt i SAMME transaksjon som selve journalraden (aldri en senere oppdatering):
--   prov_channel      kanalen identiteten kom fra (web/telegram/voice/api/system ...) - fra ToolInvocationContext.identity, aldri fra parametre
--   prov_session_id   sesjonen (for en bakgrunnsjobb: `job:<task_id>`)
--   prov_task_id      jobb-id når sesjonen er en jobbsesjon (`job:`-prefikset, se jobIdentityFor), ellers NULL
--   prov_origin       hvem som skrev INNHOLDET: `owner_direct` (hurtigbanen: eierens egne ord ordrett), `model` (en modell formulerte kallet; servingModel var satt) eller `unspecified`
--                     (trusted kode uten modell, f.eks. dashbord-ruten, eller ukjent) - `unspecified` er aldri det samme som `owner_direct`
--   prov_recorded_at  når proveniensen ble skrevet
-- Eldre rader (før denne migrasjonen) har NULL i alle fem: de er IKKE bakdatert og vises som «proveniens ikke registrert» (aldri som trygge). Skriving av proveniens er AV som standard
-- (`JARVIS_GOVERNANCE_PROVENANCE=on`), så eksisterende oppførsel er uendret til eieren slår det på. Endringer etter opprettelse (reversering, statusendring) spores kun via audit_events
-- (`tool.executed`, payload.external_id) - ikke en egen endringsproveniens (PARTIAL, dokumentert i runbooken).
--
-- Ingen ny tabell, ingen ny FK, ingen nye GRANT (kolonner arver tabellens eksisterende grants og RLS). `prov_*` inneholder aldri innhold: kun kanalnavn, sesjons-/jobb-id og en enum.

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['decision_log', 'scenarios', 'risks', 'goals', 'goal_key_results'] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN prov_channel text, ADD COLUMN prov_session_id text, ADD COLUMN prov_task_id text, ADD COLUMN prov_origin text, ADD COLUMN prov_recorded_at timestamptz', t);
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (prov_origin IS NULL OR prov_origin IN (''owner_direct'', ''model'', ''unspecified''))', t, t || '_prov_origin_check');
    -- Proveniens er alt-eller-ingenting: enten er hele settet skrevet (origin + tidspunkt + sesjon + kanal), eller ingenting (eldre rad).
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK ((prov_origin IS NULL AND prov_recorded_at IS NULL AND prov_session_id IS NULL AND prov_channel IS NULL AND prov_task_id IS NULL) OR (prov_origin IS NOT NULL AND prov_recorded_at IS NOT NULL AND prov_session_id IS NOT NULL AND prov_channel IS NOT NULL))',
      t, t || '_prov_all_or_none_check');
  END LOOP;
END
$$;
