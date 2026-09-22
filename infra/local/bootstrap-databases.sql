-- D-240: idempotent oppretting av de AUXILIARY-databasene (`infisical`/
-- `langfuse`) tjenestene under kobler til, men som Postgres-imagets EGEN
-- `POSTGRES_DB`-miljøvariabel (docker-compose.yml sin `postgres`-tjeneste)
-- KUN oppretter for PRIMÆR-databasen (`jarvis`) - en offisiell Postgres-
-- image-begrensning (`POSTGRES_DB` aksepterer nøyaktig ÉN database), ikke en
-- Jarvis-spesifikk beslutning. Uten dette krasjlooper infisical-/langfuse-
-- containerne på "database X does not exist" (fail: `db-bootstrap`-tjenesten
-- i docker-compose.yml kjører DENNE filen FØR infisical/langfuse startes,
-- se der). Funnet live av Tobias 2026-09-22 - `db-bootstrap` kjørte ALDRI
-- før, selv om D-35s BO-07-host-verifisering fra 2026-08-13 lyktes den
-- gangen (databasen må ha vært opprettet manuelt utenfor denne filen den
-- gangen, uten at det ble kodifisert).
--
-- `SELECT ... WHERE NOT EXISTS ... \gexec` er Postgres sin standardidiom for
-- en idempotent `CREATE DATABASE` (selve kommandoen kan IKKE kjøres inni en
-- transaksjon/DO-blokk) - trygt å kjøre på HVER oppstart, også når begge
-- databasene allerede finnes (f.eks. Tobias sitt eksisterende
-- `jarvis-pgdata`-volum etter denne fiksen).
SELECT 'CREATE DATABASE infisical' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'infisical')\gexec
SELECT 'CREATE DATABASE langfuse' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'langfuse')\gexec
