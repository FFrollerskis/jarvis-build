-- D-240 + REMEDIERING DEL 2 (JARVIS-009/011): idempotent oppretting av de AUXILIARY-databasene
-- (`infisical`/`langfuse`) OG deres EGNE roller. Postgres-imagets `POSTGRES_DB` oppretter kun
-- primærdatabasen (`jarvis`) - en offisiell image-begrensning - så denne filen kjøres av
-- `db-bootstrap`-tjenesten (docker-compose.yml) FØR infisical/langfuse startes.
--
-- Tidligere koblet infisical og langfuse til som cluster-superbruker (`postgres`). Nå:
--   * `infisical_app` eier KUN databasen `infisical`, `langfuse_app` eier KUN `langfuse`.
--   * begge er NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS.
--   * PUBLIC mister CONNECT på alle tre databasene; hver rolle kan kun koble til sin egen.
--   * passordene leses fra miljøet (`\getenv`), aldri hardkodet og aldri i filen.
--
-- Idempotent: trygt å kjøre på HVER oppstart, også mot et eksisterende `jarvis-pgdata`-volum der
-- databasene allerede finnes og eies av superbrukeren (eierskap overdras, innholdet røres ikke).
-- `CREATE DATABASE` kan ikke kjøres i en transaksjon/DO-blokk, derfor `\gexec`-idiomet.

\getenv infisical_pw INFISICAL_DB_PASSWORD
\getenv langfuse_pw LANGFUSE_DB_PASSWORD

-- Fail closed: tomme/manglende passord ville gi en rolle uten (eller med tomt) passord.
SELECT (:'infisical_pw' = '' OR length(:'infisical_pw') < 24) AS bad_infisical_pw \gset
SELECT (:'langfuse_pw' = '' OR length(:'langfuse_pw') < 24) AS bad_langfuse_pw \gset
-- (`\quit <kode>` finnes først i PG 18 - en feil under ON_ERROR_STOP gir ikke-null exit i alle versjoner.)
\if :bad_infisical_pw
  \echo 'INFISICAL_DB_PASSWORD mangler eller er kortere enn 24 tegn'
  DO $$ BEGIN RAISE EXCEPTION 'INFISICAL_DB_PASSWORD mangler eller er for kort'; END $$;
\endif
\if :bad_langfuse_pw
  \echo 'LANGFUSE_DB_PASSWORD mangler eller er kortere enn 24 tegn'
  DO $$ BEGIN RAISE EXCEPTION 'LANGFUSE_DB_PASSWORD mangler eller er for kort'; END $$;
\endif

-- Roller: opprett hvis de mangler, sett alltid passord + minimale attributter (rotasjon via .env).
SELECT format('CREATE ROLE %I LOGIN', 'infisical_app')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'infisical_app') \gexec
SELECT format('CREATE ROLE %I LOGIN', 'langfuse_app')
  WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'langfuse_app') \gexec

SELECT format('ALTER ROLE infisical_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'infisical_pw') \gexec
SELECT format('ALTER ROLE langfuse_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'langfuse_pw') \gexec

-- Databaser: opprett med riktig eier; en eksisterende database (superbruker-eid) overdras.
SELECT 'CREATE DATABASE infisical OWNER infisical_app'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'infisical') \gexec
SELECT 'CREATE DATABASE langfuse OWNER langfuse_app'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse') \gexec

ALTER DATABASE infisical OWNER TO infisical_app;
ALTER DATABASE langfuse OWNER TO langfuse_app;

-- Isolasjon mellom databasene: ingen PUBLIC-tilkobling; kun egen rolle (og eierne) kan koble til.
REVOKE CONNECT ON DATABASE infisical FROM PUBLIC;
REVOKE CONNECT ON DATABASE langfuse FROM PUBLIC;
GRANT CONNECT ON DATABASE infisical TO infisical_app;
GRANT CONNECT ON DATABASE langfuse TO langfuse_app;

-- Eierskap til eksisterende objekter + extensions. Både Infisical (knex) og Langfuse (prisma)
-- bruker pgcrypto/uuid-ossp; `CREATE EXTENSION` krever superbruker for ikke-trusted extensions,
-- derfor gjøres det her (som admin) og ikke av app-rollen. pgcrypto/uuid-ossp/pg_trgm er "trusted"
-- i PG13+, men å installere dem her holder app-rollen helt uten ekstra privilegier.
\connect infisical
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO infisical_app;
SELECT format('ALTER TABLE %I.%I OWNER TO infisical_app', schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'infisical_app' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO infisical_app', sequence_schema, sequence_name)
  FROM information_schema.sequences s
  WHERE sequence_schema = 'public'
    AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
          WHERE c.oid = format('%I.%I', s.sequence_schema, s.sequence_name)::regclass) <> 'infisical_app' \gexec

\connect langfuse
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pg_trgm;
ALTER SCHEMA public OWNER TO langfuse_app;
SELECT format('ALTER TABLE %I.%I OWNER TO langfuse_app', schemaname, tablename)
  FROM pg_tables WHERE schemaname = 'public' AND tableowner <> 'langfuse_app' \gexec
SELECT format('ALTER SEQUENCE %I.%I OWNER TO langfuse_app', sequence_schema, sequence_name)
  FROM information_schema.sequences s
  WHERE sequence_schema = 'public'
    AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c
          WHERE c.oid = format('%I.%I', s.sequence_schema, s.sequence_name)::regclass) <> 'langfuse_app' \gexec
