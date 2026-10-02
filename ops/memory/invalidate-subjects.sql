-- D-373: eier-opprydding av duplikat-/motstridende minner. Gjør NØYAKTIG det MemoryWriter.invalidate() gjør (bitemporal versjon
-- 'invalidated' + status='invalidated' + audit `memory.invalidate`), men for flere emner på en gang. Ingenting slettes.
-- Kjøres som DB-admin (RLS omgås), mot kun AKTIVE rader med de oppgitte emnene:
--   docker compose -f infra/local/docker-compose.yml exec -T postgres psql -U postgres -d jarvis \
--     -v subjects="'emne.a','emne.b'" < ops/memory/invalidate-subjects.sql
\set ON_ERROR_STOP on
BEGIN;
CREATE TEMP TABLE _inv ON COMMIT DROP AS
  SELECT memory_item_id, tenant_id, owner_person_id, space, version, subject, content, valid_from
  FROM memory_items
  WHERE status = 'active' AND subject IN (:subjects);
INSERT INTO memory_versions (memory_item_id, tenant_id, space, version, subject, content, valid_from, valid_to, change_kind)
  SELECT memory_item_id, tenant_id, space, version, subject, content, valid_from, now(), 'invalidated' FROM _inv;
UPDATE memory_items SET status = 'invalidated', valid_to = now(), updated_at = now()
  WHERE memory_item_id IN (SELECT memory_item_id FROM _inv);
INSERT INTO audit_events (tenant_id, person_id, type, payload)
  SELECT tenant_id, owner_person_id, 'memory.invalidate',
         jsonb_build_object('memory_item_id', memory_item_id, 'subject', subject, 'reason', 'owner_cleanup_d373')
  FROM _inv;
SELECT subject, content AS invalidert_innhold FROM _inv ORDER BY subject;
COMMIT;
