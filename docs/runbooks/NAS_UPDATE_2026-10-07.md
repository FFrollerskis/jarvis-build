# NAS-oppdatering 2026-10-07 (D-427…D-446)

Sjekkliste for neste NAS-oppdatering. **Ingenting under er verifisert på NAS ennå** – det som står under «Forventet» er hva koden og testene sier, ikke observert drift. Kjør ett steg om gangen, lim inn utdata, og stopp ved første avvik.

**Merk:** punkter merket med migrasjon 078–082 og D-437/D-438 forutsetter at PR #286, #288 og #289 er merget før du oppdaterer; D-441/D-444 kom med #295 og D-442/D-443 med #296. Sjekk `git log --oneline -15` etter `git pull`.

Alle kommandoer kjøres fra `/volume1/jarvisbuild-data/jarvisbuild` (compose og `.env` finnes bare der).

## Hva som er nytt siden NAS sist kjørte `85b69c5`

| Beslutning | Endring | Hva du bør se |
|---|---|---|
| D-425/426 | Småprat gir ingen verktøy; klage + forespørsel i samme melding beholder verktøy | Ingen verktøykall på «hei»; verktøy på «sjekk github, du glemte det forrige» |
| D-427/429 | Bakgrunnsjobb får GitHub-lesing; `repo` er valgfri (standard `JARVIS_GITHUB_REPO`) | Bakgrunnsjobb «list PR-er» gir svar |
| D-428 | Minneutvinning forkaster fakta som ikke kan spores til eierens egne ord | Ingen nye «lånte» minner fra Jarvis sine svar |
| D-430 | Ærlig svar ved verktøyfeil (aldri oppdiktet) | «kunne ikke hente X: <årsak>» i stedet for et påstått svar |
| D-431 | Verktøyturer til Sonnet 5.5; ren prat lokalt | Logglinje `tool_turn_route` |
| D-432 | Prompt-caching + dagstak 30 kr for verktøyturer til sky | `daily_cap_ore: 3000` i samme linje; `cached_tokens` i `cost_events` |
| D-433 | Worker eier `executive`-køen | Logglinje `executive_queue_owner: worker` |
| D-434 | Worker-miljø: 13 connector-variabler i stedet for ca. 90 | Worker starter; bakgrunnsjobb og kodejobb fullfører |
| D-435 | Alle 113 tenant-kryssende FK-er er komposittnøkler (migrasjon 078–080) | Migrasjonene anvendt; api og worker starter |
| D-436 | `tool-gateway`-leverandørkall via `guardedFetch` (Infisical, Zapier, browser); Infisical-lesing har 5 s tak | Infisical-lesing og browser-verktøy virker |
| D-437 | Rettelser etter review av D-434: modusvariabler, `evaluation_caveat` på capability-status fra worker | `check_my_capabilities` fra en bakgrunnsjobb har et forbehold om snevret miljø |
| D-438 | Infra-modus (pause/degrade) deles mellom API og worker (migrasjon 082) | `POST /infra/pause` i API stanser også worker innen få sekunder |
| Q-44 (D-435) | Pre-flight i migrasjon 078 + koblingstabellen `incident_diagnosis_evidence` fikk `tenant_id` (081) | Migrasjon 078–081 anvendt |
| D-441 | Et tomt eller avkuttet modellsvar i chat er ikke lenger en «stille suksess»: retry ved avkorting, neste kandidat, ellers en ærlig feil; avbrutte turer fortsetter ikke i bakgrunnen | Ingen tomme chatsvar uten forklaring |
| D-442 | 17 daglige bakgrunnsjobber feiler ikke lenger stille: tenant-feil gir nytt forsøk (1/5/15 min, maks 4 per dag) og `last_error`; morgenbrief som ikke kom frem prøves på nytt; lange jobber fornyer claimet | `scheduler_state.last_error` fylles ved feil |
| D-443 | Daglige jobber som feiler eller gir opp vises i «Hva er galt med deg?» (område «Daglige bakgrunnsjobber») og i morgenbriefen | Se punkt 4c |
| D-444 | Tomt svar fra lokal modell faller tilbake til vanlig ruting (som ved timeout) i stedet for «Noe gikk galt» | Logglinje `d404_gemma_provider_failed_fallback` med `kind: "invalid_response"`; kan gi en skykostnad |
| D-445 | Nattjobbene som bruker PC-ens lokale modell (`memory-reembed-sweep`, `memory-retention-sweep`) er «best effort»: de prøves på nytt, men et tap er DEGRADED (aldri DOWN, aldri i morgenbriefen) | Ingen morgenvarsel selv om PC-en var av om natten |
| D-446 | Jobbkøen: en jobb hvis worker krasjer gjenopptas høyst én gang og settes deretter til `failed` (tidligere kjørte den i det uendelige); retry med ventetid (`backoff_seconds`) | Migrasjon 083 og 084 anvendt; en krasjet jobb ender som `failed` med `lease_expired_claims_exhausted` |

## 0. Før du starter (1 min)

Kjør sikkerhetskopi først hvis du ikke har en fersk (migrasjon 078–080 endrer nøkler, ikke data, men det er en skjemaendring):

```
ls -lt <backup-mappen> | head -3
```

Er den eldre enn ett døgn: kjør den vanlige backupen før du går videre.

## 1. Hent og bygg

```
git pull
```

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build
```

**Forventet:** bygget går gjennom, `migrate` avslutter med kode 0, api og worker starter.
**Avvik å melde fra om:** `migrate` feiler. Feilen er da sannsynligvis `violates foreign key constraint … _tenant` – en eksisterende rad krysser tenant. **Fjern ikke nøkkelen**; lim inn hele feilmeldingen, så finner vi raden.

## 2. Tjenester oppe

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml ps
```

**Forventet:** `api` og `worker` kjører (api healthy), `postgres` healthy.

## 3. Migrasjonene er anvendt

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 5;"
```

**Forventet (forutsetter at #286, #299 og rettelsen #300 er merget):** `084_task_claim_guard_safe_cap.sql`, `083_task_claim_poison_guard.sql`, `082_owner_control_infra_mode.sql`, `081_tenant_scope_fk_incident_evidence.sql`, `080_tenant_scope_fk_rest.sql` øverst. (Migrasjon 083 alene har en kjent feil som 084 retter; oppdater aldri til en `main` som har 083 uten 084.)

## 4. Loggene bekrefter ruting og køeier

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml logs --tail 300 api | grep -E "tool_turn_route|executive_queue_owner"
```

**Forventet:**
- `tool_turn_route` med `route: "anthropic:claude-sonnet-5-5"` og `daily_cap_ore: 3000`
- `executive_queue_owner` med `owner: "worker"`

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml logs --tail 100 worker | grep -iE "started|error|drain_error"
```

**Forventet:** `jarvis-worker started`, ingen `drain_error`.

## 4b. Infra-modus deles mellom api og worker (D-438)

Dette endrer driftsmodus midlertidig og er trygt; husk å løse den igjen. Bruk et gyldig eier-token fra dashbordet/nettleseren – ikke lim tokenet i chat. Modusen leses LIVE av begge prosessene (ingen synkforsinkelse å vente på).

1. Sett pause (`POST /infra/pause` med en begrunnelse).
2. Spør status (`POST /infra/status`). **Forventet:** `infra_mode.mode: "PAUSED"`, `infra_mode_shared.mode: "PAUSED"`, `infra_mode_shared_readable: true` og `infra_mode_in_sync: true`.
3. Bekreft at den delte raden finnes (det er DEN workeren leser):

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c "SELECT control_kind, control_target, reason, changed_at FROM owner_control_state WHERE control_kind = 'infra_mode';"
```

   **Forventet:** én rad med `GLOBAL` og en JSON-`reason` med `"mode":"PAUSED"`.
4. Løs den: `POST /infra/resume`. Raden skal da være borte (NORMAL lagres aldri).

**Avvik å melde fra om:**
- `infra_mode_in_sync: false` eller `infra_mode_shared: null` mens `infra_mode.mode` er `PAUSED`: pausen gjelder bare API-prosessen (lagringen feilet) – workeren er IKKE stanset. Svaret på selve pause-kallet var da også en feil (`infra_mode_persist_failed`).
- `infra_mode_shared_readable: false`: den delte tilstanden kan ikke leses; infra-mutasjoner (github/docker, klasse B/C/D) avslås da med `infra_mode_unavailable` (fail-closed) til databasen svarer.
- 403 `owner_control_unauthorized`: kallet kom ikke fra eier-identiteten (kun eieren kan endre modusen).

## 4c. Daglige bakgrunnsjobber (D-442/D-443)

Gjør dette tidligst et døgn etter oppdateringen, ellers finnes ingen rader å vise. Nye jobber får en rad i `scheduler_state` første gang de kjører.

1. Skriv i chat: «Hva er galt med deg?». **Forventet:** området «Daglige bakgrunnsjobber» er OK («N av M daglige jobber er fullført, ingen feil») – eller UKJENT hvis ingen jobb har kjørt ennå. DOWN/DEGRADED nevner jobbnavn og siste feil i klartekst.
2. Se råtilstanden (siste to dager):

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c "SELECT job_name, run_date, attempts, completed_at IS NOT NULL AS ferdig, retry_after, left(last_error, 140) AS siste_feil FROM scheduler_state WHERE run_date >= current_date - 1 ORDER BY run_date DESC, job_name;"
```

   **Forventet:** nesten alle `ferdig = t`. En jobb uten noe å gjøre (for eksempel business-synk uten business-tenant) fullfører også med `ferdig = t`.
3. Finnes det business-tenants i det hele tatt? (Avgjør om business-jobbene gjør noe.)

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml logs --tail 300 api | grep -E "business_tenants_enumerated|business_sweeps_no_business_tenants"
```

   `business_sweeps_no_business_tenants` betyr at alle business-sveip er tomme (forventet inntil tenant-oppsettet er bestemt, JARVIS-044).

**Avvik å melde fra om:**
- En jobb med `attempts = 4` og `ferdig = f`: den ga opp. Lim inn `siste_feil`. Unntak: `memory-reembed-sweep` og `memory-retention-sweep` bruker PC-ens lokale modell og kan gi opp de nettene PC-en er av; de vises som «avhenger av PC-en; tas igjen neste kjøring» (DEGRADED) og er ikke et avvik.
- `credential_not_bound_to_identity` fra `business-events-sync`, `conversation-graph-sync` eller `support-inbox-sync`: kjent (Q-48). Planlagte jobber kjører som `system` og kan ikke bruke din Google-konto. Du må velge løsning; se `docs/OPEN_QUESTIONS.md`.
- Dagens morgenbrief nevner «Bakgrunnsjobb uten resultat: …»: en jobb ga opp eller ble ikke fullført i går.

## 5. Akseptanseportene

```
ops/acceptance/nas-ua0-gate.sh
```

**Forventet:** ikke flere FAIL enn sist (sist: 9 PASS / 2 WARN / 1 UNKNOWN). WARN og UNKNOWN regnes ikke som bestått.

## 6. Chat-testene (i nettleseren, én om gangen)

1. «hei» → svar uten verktøykall, rask lokal modell.
2. «sjekk github og list åpne PR-er» → svar med ekte PR-er, eller en ærlig «kunne ikke hente … fordi …». Aldri «jeg har ikke tilgang» hvis `JARVIS_GITHUB_TOKEN` er satt.
3. «du svarte feil, sjekk github igjen» → verktøy beholdes (D-426).
4. En bakgrunnsjobb («list PR-er i bakgrunnen») → fullfører; sjekk i loggen at **worker** tok den.
5. Spør om noe fra e-post/kalender → verktøyturen går til Sonnet 5.5.
6. Ser du «Noe gikk galt under generering. Prøv igjen.»: hent loggraden og lim den inn.

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml logs --tail 300 api | grep -E "chat_stream_error|no_usable_output|d404_gemma_provider_failed_fallback|d431_cloud_tools_failed_fallback_local|stream_consumer_error"
```

   `d404_gemma_provider_failed_fallback` med `kind: "invalid_response"` betyr at den lokale modellen svarte tomt og at svaret kom via vanlig ruting (D-444).

## 7. Kostnad etter noen dager

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c "SELECT date_trunc('day', at AT TIME ZONE 'Europe/Oslo')::date AS dag, provider, model, count(*) AS kall, sum(amount_ore) AS ore, sum(input_tokens) AS inn FROM cost_events GROUP BY 1,2,3 ORDER BY 1 DESC, 5 DESC LIMIT 20;"
```

**Forventet:** `gemma_local` med 0 øre; Sonnet-rader med lavere øre per kall enn før (cache-treff).
Dagstak: når dagens sum overstiger 30 kr, får verktøyturer en fast merknad og går lokalt.
Skyrader for vanlig prat (ikke verktøytur) etter D-444 betyr at den lokale modellen svarte tomt eller var nede; tell dem og si fra hvis de er mange.

## Hvis noe går galt

- **En bakgrunnsjobb står som `failed` med `lease_expired_claims_exhausted`:** workeren krasjet eller ble stoppet to ganger mens jobben kjørte (for eksempel en oppdatering midt i en jobb). Jobben startes ikke på nytt; be om den på nytt. Se `logs worker` rett før feilen for årsaken.

- **Worker starter ikke etter D-434:** en handler mangler en nøkkel. Lim inn `logs worker`; nøkkelen legges i `WORKER_CONNECTOR_ENV` (`infra/local/service-env.mjs`).
- **Infisical-lesing feiler etter D-436:** sjekk at `INFISICAL_URL` er `http://infisical:8080` (vertsnavn uten understrek).
- **Tilbakerulling:** `git checkout 85b69c5` og samme `up -d --build`. Migrasjon 078–080 reverseres ikke automatisk. Gammel kode setter alltid `tenant_id` på radene sine, så komposittnøklene skal ikke stoppe den, men det er **ikke testet**. Migratoren rapporterer de nyere migrasjonene som «ukjente» (`unknown_applied`) uten å avbryte planen. Behold backupen fra steg 0 til alt er bekreftet.
