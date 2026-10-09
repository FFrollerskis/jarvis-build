# Postgres-drift som kontrollert mål (WP-E1, UA-5) - eier-oppsett, sikkerhetsmodell og akseptanse

**Status (2026-10-09): BYGGET OG TESTET MOT EKTE POSTGRES 16 (embedded, som en minste-privilegium-rolle) - SOVENDE - IKKE KJØRT MOT NAS-ens Postgres.** Connectoren gjør
ingenting før `JARVIS_POSTGRES_OPS_URL` er satt. Alt under merket `NOT VERIFIED` bekrefter DU på NAS-en før du stoler på det.

**D-64 (Core-vs-Adapter):** databasen er Jarvis' EGEN kjerne (`JARVIS_CANONICAL`) - dette er et DRIFTSVERKTØY mot den, ikke en leverandør-adapter, og ingen tredjepart
blir domenekjerne (`CORE_DEPENDENCY_DECISION_REQUIRED=false`). **D-41:** diagnostikk er klasse A; de tre skrivehandlingene er klasse D med hele kjeden. Det som ikke er bygget
står i §5 som `DEFERRED`/`PARTIAL`.

## 1. Hva verktøyet kan (verktøy-id `postgres_ops`, eier-eksklusivt navnerom - aldri på en modellflate)

| Handling | Klasse | Hva |
|---|---|---|
| `get_connections` | A | antall økter per tilstand/database/rolle/applikasjon mot `max_connections` (uten spørringstekst) |
| `get_long_running_queries` | A | lange spørringer og åpne transaksjoner (varighet, ventehendelse, **normalisert** spørringstekst) + `pid`, `backend_start`, `query_start` som terminate/cancel krever |
| `get_locks` | A | hvem blokkerer hvem (`pg_blocking_pids`) |
| `get_table_sizes`, `get_bloat_estimate` | A | tabellstørrelse; bloat som ESTIMAT (døde/levende tupler - ikke byte-nøyaktig) |
| `get_replication_status` | A | primær/standby, replikaer med lag, slots (enkelt-node = «ingen replikaer», et gyldig svar) |
| `get_migration_state` | A | anvendt/ventende/endret sjekksum/ukjent mot filene i koden (`planMigrations`, skrivebeskyttet) |
| `get_backend`, `get_query_state`, `get_table_stats` | A | mål-oppslag brukt som preflight/readback |
| `terminate_backend` | **D** | `pg_terminate_backend` på én økt identifisert med `pid` + `backend_start` + `database` |
| `cancel_query` | **D** | `pg_cancel_backend` på den inspiserte spørringen (`pid` + `backend_start` + `query_start` + `database`) |
| `vacuum_analyze` | **D** | `VACUUM (ANALYZE)` (eller kun `ANALYZE`) på én navngitt tabell i autorisert skjema - **PARTIAL, krever tabell-eierskap** (§4) |

**Spørringstekst er data, ikke instruksjon.** Den normaliseres (kommentarer, streng-/dollar-literaler og tall erstattes med `?`, IN-lister slås sammen, teksten avkortes til 200 tegn og skannes for
hemmeligheter) og vises kun for økter i databaser du har autorisert; økter i andre databaser får ingen tekst. Utdata merkes `untrusted`.

## 2. Klasse D-kjeden og «tenant-eide mål»

- **Mål-autorisasjon FØR noen I/O** (`ToolGateway.parameterAuthorizer`): databasen MÅ stå i `JARVIS_POSTGRES_OPS_DATABASES` (tom = ingen skriving), skjemaet for VACUUM i `JARVIS_POSTGRES_OPS_SCHEMAS` (standard `public`). Infisical- og Langfuse-databasene er tredjeparts-eide og er bevisst IKKE «tenant-eide mål» med mindre du selv legger dem inn.
- **Akkurat den økten du så:** terminate krever `pid` + `backend_start`, cancel i tillegg `query_start`. PID-er gjenbrukes av operativsystemet - uten `backend_start` kunne en uskyldig ny økt blitt rammet. Sjekken og signalet sitter i ÉN atomisk SQL-setning, så det finnes intet vindu mellom «sjekk» og «handling».
- **Aldri rammet:** superbruker-økter, ikke-klient-prosesser (autovacuum, WAL-sendere, checkpointer …), ops-tilkoblingen selv, og roller i `JARVIS_POSTGRES_OPS_PROTECTED_ROLES`.
- **Preflight** leser økten på nytt og avviser hvis den ikke lenger er den samme; **snapshot** (økt, rolle, applikasjon, normalisert spørring, varighet) journalføres; **idempotens-nøkkel** er påkrevd; **readback** bekrefter at økten er borte / spørringen ikke lenger kjører / tabellen er nylig vacuumet; **umiddelbar varsling** (Telegram).
- **Ærlig gjenoppretting:** en terminert økt kan ikke gjenopprettes og en avbrutt spørring kan ikke gjenopptas - `recovery_available=false` og planteksten sier det (applikasjonen kobler til på nytt). VACUUM/ANALYZE trenger ingen reversering.
- `PAUSED` (infra-pause) stanser all skriving, `DEGRADED` stanser klasse D, lesing stanses aldri. Kun eieren kan bruke verktøyet (credential-binding); en delegert identitet får `credential_not_bound_to_identity`.
- Hvert kall bruker en egen, kortlevd tilkobling med `statement_timeout`, `lock_timeout` og `idle_in_transaction_session_timeout`; `application_name = jarvis-ops`.

## 3. EIERHANDLING - opprett en dedikert rolle med minste rettigheter

Aldri superbrukeren, og aldri app-rollen `jarvis_runtime` (den er underlagt RLS og skal ikke kunne signalere andres økter). Kjør som superbruker i NAS-ens Postgres-container:

```sql
-- passordet: 32+ tegn a-zA-Z0-9 (genereres av deg; limes aldri i chat)
CREATE ROLE jarvis_ops LOGIN PASSWORD '<passord>' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
GRANT pg_monitor TO jarvis_ops;          -- leser pg_stat_activity/pg_locks/… for ALLE roller (uten den ser rollen bare egne økter: visibility=limited)
GRANT pg_signal_backend TO jarvis_ops;   -- kan avbryte/terminere økter til IKKE-superbrukere (aldri superbrukere)
GRANT CONNECT ON DATABASE jarvis TO jarvis_ops;
GRANT SELECT ON schema_migrations TO jarvis_ops;   -- get_migration_state (skrivebeskyttet)
```

Sett deretter i `.env` på verten (aldri via dashbordet) og restart `api`:

| Variabel | Standard | Effekt |
|---|---|---|
| `JARVIS_POSTGRES_OPS_URL` | tom | `postgresql://jarvis_ops:<passord>@postgres:5432/jarvis`. Tom = hele connectoren er `credential_unavailable` (sovende). Kun ren `postgres(ql)://`-URL; `options=`/`application_name=`/`search_path=` avvises. |
| `JARVIS_POSTGRES_OPS_DATABASES` | tom | f.eks. `jarvis`. Databaser klasse D-drift er tillatt mot. Tom = ingen skriving. |
| `JARVIS_POSTGRES_OPS_SCHEMAS` | `public` | skjema VACUUM/ANALYZE får røre |
| `JARVIS_POSTGRES_OPS_PROTECTED_ROLES` | tom | roller hvis økter aldri røres, f.eks. `jarvis_migrate` (superbrukere er alltid beskyttet) |

Passordet i `.env` er en hemmelighet som alle andre connector-nøkler (git-ignorert; lekker det, endre `jarvis_ops`-passordet med `ALTER ROLE` og oppdater `.env`).

## 4. VACUUM og tabell-eierskap (PARTIAL)

PG16 har ingen `pg_maintain`-rolle (kommer i PG17), så `VACUUM` krever at rollen **eier** tabellen. I standardoppsettet eies tabellene av admin-rollen; da hopper Postgres over VACUUM med bare en advarsel, og verktøyet rapporterer
`postgres_vacuum_skipped_insufficient_privilege` - aldri en påstått suksess. Alternativer, alle eierbeslutninger:
1. La autovacuum gjøre jobben (normalt tilstrekkelig) og bruk `get_bloat_estimate` kun til å oppdage et problem.
2. Kjør VACUUM manuelt som superbruker: `docker exec <postgres> psql -U postgres -d jarvis -c 'VACUUM (ANALYZE) public.<tabell>'`.
3. Overfør eierskap av utvalgte tabeller til `jarvis_ops` (`ALTER TABLE … OWNER TO jarvis_ops`) - endrer hvem som kan ALTER/DROP tabellen; **NOT VERIFIED** mot Jarvis' migreringsflyt (migratoren forutsetter at admin-rollen eier tabellene). Anbefales ikke uten en egen vurdering.
**Gi aldri `jarvis_ops` medlemskap i en superbruker-rolle** (`SET ROLE` ville gjort tilkoblingen til superbruker).

## 5. Kjente begrensninger (D-41: `DEFERRED`/`PARTIAL`, aldri stille utelatt)

- **DEFERRED:** `VACUUM FULL`, `REINDEX`, `CLUSTER`, DDL, `ALTER SYSTEM`, rolle-/privilegiestyring, sletting av replikasjonsslot (ACCESS EXCLUSIVE-lås = nedetid, eller irreversibelt; krever vedlikeholdsvindu og egen eierbeslutning - aldri autonomt). Terminere/avbryte økter i databaser du ikke har autorisert. Backup/restore (dekkes av `ops/backup`, WP-C2).
- **PARTIAL:** `VACUUM` (eierskap, §4); bloat er et estimat (`pgstattuple` for eksakt tall er ikke installert); diagnostikk gjelder tilkoblingens database (`pg_stat_user_tables` er per database), mens økt-/lås-lister er klyngeomfattende; én tilkobling = én database for VACUUM.
- Replikasjonsstatus er testet kun som enkelt-node (primær uten replikaer); standby-grenen (`pg_stat_wal_receiver`) er ikke kjørt mot en ekte standby - **NOT VERIFIED**.

## 6. Bruk (alle kall med `grant_token` i kroppen)

```
POST /infra/cloud/read
{ "grant_token": "<session-grant>", "provider": "postgres_ops", "action": "get_long_running_queries", "parameters": { "min_seconds": 30 } }
```
Svaret gir `pid`, `backend_start`, `query_start` og `eligible_for_mutation` per økt. Deretter:
```
POST /infra/cloud/mutate
{ "grant_token": "<session-grant>", "provider": "postgres_ops", "action": "terminate_backend",
  "parameters": { "pid": 12345, "database": "jarvis", "backend_start": "2026-10-09T12:00:00.123456Z" },
  "idempotency_key": "pg-term-2026-10-09-1", "incident_id": "<valgfri>" }
```
Svaret er den sammenhengende `infra_executions`-raden (aktør, klasse D, mål `postgres:<db>:backend:<pid>@<start>`, `before_state`, `verification_outcome`, `recovery_available=false`). Hent den senere med `POST /infra/execution/get`.
En retry med samme nøkkel og samme mål gir den eksisterende raden uten ny utførelse.

## 7. Akseptanse på NAS-en (`NOT VERIFIED` til du har kjørt den)

1. Opprett `jarvis_ops` (§3), sett `JARVIS_POSTGRES_OPS_URL` og `JARVIS_POSTGRES_OPS_DATABASES=jarvis`, restart `api`.
2. Lesing: `get_connections` (forventet `visibility: full`, `connected_as: jarvis_ops`), `get_migration_state` (forventet `in_sync: true`), `get_table_sizes`, `get_replication_status` (forventet `primary`, 0 replikaer).
3. Lag en testøkt: `docker exec -it <postgres> psql -U postgres -d jarvis -c "select pg_sleep(600)"` i et eget vindu (superbruker-økt!) - verifiser at `terminate_backend` mot DEN nektes med `postgres_backend_superuser_protected`.
4. Lag en testøkt som en vanlig, ikke-superbruker-rolle (f.eks. en midlertidig `CREATE ROLE victim LOGIN …`) og kjør `pg_sleep(600)`; finn den med `get_long_running_queries`, `cancel_query` (forventet: spørringen avbrutt, økten lever), deretter `terminate_backend` (forventet: økten borte, `SUCCESS`, Telegram-varsel, `infra_executions`-rad).
5. Prøv terminate med feil `backend_start` - forventet `preflight_target_not_found`, ingenting skjer. Prøv en database utenfor listen - forventet `postgres_database_not_authorized`.
6. `POST /infra/pause`, forsøk terminate - forventet `infra_paused`; lesing virker; `POST /infra/resume`.
7. Lim utfallet (uten passord) inn i chatten; først da regnes connectoren som VERIFIED mot ekte NAS-Postgres.

## 8. Avvikling og nødstopp

- **Stopp skriving umiddelbart:** `POST /infra/pause`, eller tøm `JARVIS_POSTGRES_OPS_DATABASES` og restart `api`.
- **Fjern hele kapabiliteten:** tøm `JARVIS_POSTGRES_OPS_URL` og/eller `DROP ROLE jarvis_ops` (terminér rollens økter først: `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'jarvis_ops'`).
- **Passord lekket:** `ALTER ROLE jarvis_ops PASSWORD '<nytt>'`, oppdater `.env`, restart `api`.
