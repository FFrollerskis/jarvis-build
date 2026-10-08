# NAS-oppdatering 2026-10-07 (D-427…D-446)

Sjekkliste for neste NAS-oppdatering. **Det meste under er ikke verifisert på NAS** – det som står under «Forventet» er hva koden og testene sier, ikke observert drift. Bare steg med en egen **«Observert»**-linje er målt på NAS-en (oppdateringen 2026-10-08). Kjør ett steg om gangen, lim inn utdata, og stopp ved første avvik.

**Merk:** punkter merket med migrasjon 078–082 og D-437/D-438 forutsetter at PR #286, #288 og #289 er merget før du oppdaterer; D-441/D-444 kom med #295 og D-442/D-443 med #296. Sjekk `git log --oneline -15` etter `git pull`.

Alle kommandoer kjøres fra `/volume1/jarvisbuild-data/jarvisbuild` (compose og `.env` finnes bare der).

## Koble til NAS-en (PuTTY, også når du ikke er hjemme)

| PuTTY-felt | Verdi |
|---|---|
| Host Name (or IP address) | `100.76.2.58` |
| Port / Connection type | `22` / SSH |
| login as | `Jarvis` (stor J), deretter passordet til NAS-brukeren |

`100.76.2.58` er NAS-ens **Tailscale-adresse** og virker fra alle nett. `10.0.0.30` / `10.0.0.138` er hjemmenettet (LAN) og virker KUN når maskinen sitter på samme nett som NAS-en. I Tailscale heter NAS-en `dxp4800plus-ring`; `jarvis-nas-2` / `jarvis-nas-1` i eldre dokumenter er gamle navn. Adressen og navnet er sist bekreftet 2026-10-02 med `sudo docker exec tailscaled tailscale status` på NAS-en (Tailscale kjører der som container, ikke som vertstjeneste). Oppkobling fra et annet nett enn hjemmenettet er ikke dokumentert testet.

1. Tailscale må kjøre og være pålogget med samme konto som NAS-en (vises som `post@…` i `tailscale status`) på maskinen du sitter ved. I Tailscale-menyen skal `dxp4800plus-ring` stå i listen over enheter og ikke være offline. Er den offline, er NAS-en av eller uten internett, og da kommer du ikke inn før den er det. Står ikke maskinen din i listen (2026-10-02 hadde tailnettet én Windows-maskin, `srby`), må Tailscale installeres og logges inn der først.
2. Skriv adressen selv. Første gang fra en ny maskin viser PuTTY «host key not cached»; det er normalt, velg Accept.
3. Lagre økten under «Saved Sessions» (for eksempel «Jarvis-NAS»), så er neste gang ett klikk.
4. Etter innlogging, gå til arbeidsmappen:

```
cd /volume1/jarvisbuild-data/jarvisbuild
```

**Feilsøking:** `Connection timed out` = Tailscale er ikke tilkoblet på din maskin, eller NAS-en er offline (punkt 1). `Connection refused` = NAS-en svarer, men tar ikke imot SSH på port 22. `Access denied` = feil bruker eller passord (stor J i `Jarvis`).

**Observert 2026-10-08:** innlogging med `100.76.2.58`, port 22, bruker `Jarvis` fra et annet nett enn hjemmenettet fungerte (PuTTY).

## Innrullere en ny nettleser eller enhet

Hver nettleser må innrulleres én gang per adresse med en engangsbillett fra NAS-en; siden viser «Denne enheten er ikke innrullert ennå». Hintet `pnpm --filter @jarvis/api enroll-ticket` virker **ikke** på NAS-en: CLI-en trenger admin-databasetilgang, og den finnes bevisst bare i `migrate`-tjenesten (Remediering del 2), ikke i `api`/`worker`. Kjør i stedet fra `/volume1/jarvisbuild-data/jarvisbuild`:

```
ops/nas/enroll-device.sh https://dxp4800plus-ring.tail3935f7.ts.net
```

Adressen må være **den samme HTTPS-adressen nettleseren bruker**: enhetsnøkkelen lagres per nettleser og adresse, og nettleseren krever HTTPS for å lage den, så `http://` og LAN-adressen (`10.0.0.30:3010`) fungerer ikke. Valgfritt andre argument velger landingsside: `dashboard` (standard), `voice` eller `chat`. Billetten er engangs og gyldig i 15 minutter.

1. Marker hele lenken skriptet skriver ut (`…?enroll=…`) med musen (dra over den; ikke dobbeltklikk, for `-` og `_` deler ordet) og lim den inn i nettleserens adressefelt. Siden innrullerer seg selv og viser «Enheten er innrullert.»
2. Virker ikke lenken, lim den korte billett-strengen inn i feltet «Innrullerings-billett» på siden.
3. Lim **aldri** billetten eller lenken inn i chat. `enrollment_ticket_invalid` betyr utløpt, allerede brukt eller feilkopiert: kjør skriptet på nytt.

**Observert 2026-10-08:** den underliggende kommandoen (`docker compose … run --rm --no-deps -e JARVIS_PUBLIC_VOICE_BASE_URL=… migrate node --experimental-transform-types apps/api/src/enroll-ticket-main.ts --path dashboard`) ble kjørt av eieren, og siden viste «Enheten er innrullert.» **Ikke observert:** selve skriptet `ops/nas/enroll-device.sh` (testet mot en falsk `docker`, ikke på NAS-en), og at innrulleringstekstene på sidene (som nevner skriptet) først vises etter neste bygg.

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
| D-447 | En verktøytur som tvinges til den lokale modellen av sensitivitetsregelen (økonomi/helse/hemmeligheter i de siste meldingene) får en synlig merknad i svaret og logglinjen `d447_tool_turn_local_sensitivity` | Merknaden «Svart på den lokale modellen …» når samtalen nylig berørte økonomi; ellers uendret |
| D-448 | Ordene «gjelder/gjelde/gjeldende» og «bicycle» utløser ikke lenger økonomi-regelen (lokal-tvang); gjeld/gjelden/gjeldsbrev og BIC fanges fortsatt | Verktøyturer i en samtale med «gjelder» går til Sonnet (`cost_events`: `anthropic`), ikke til `llama3.1:8b`; gjenta chat-test 3 |
| D-449 | Delegerte bakgrunnsjobber MED verktøy bruker chattens skyrute (Sonnet 5.5) under samme dagstak; økonomi/helse/hemmeligheter forblir lokale | «list åpne PR-er på tsworkflow/jarvisbuild i bakgrunnen» gir ekte PR-er; `cost_events` har `anthropic`-rader for jobben; worker-loggen har `d449_job_tool_route` med `route: "cloud"` |

## 0. Før du starter (1 min)

Kjør sikkerhetskopi først hvis du ikke har en fersk (migrasjon 078–080 endrer nøkler, ikke data, men det er en skjemaendring). De krypterte settene ligger i `/volume1/jarvisbuild-data/backups/encrypted`; en cron-jobb (`17 2 * * *`, installert 2026-10-03) tar et nytt hver natt. **Observert 2026-10-08:** settene fra 7. og 8. oktober kl. 02:17 fantes, så cron har kjørt de to siste nettene:

```
ls -lt /volume1/jarvisbuild-data/backups/encrypted | head -3
```

Er det nyeste eldre enn ett døgn (se også `/volume1/jarvisbuild-data/backups/backup.log`): kjør backupen manuelt før du går videre:

```
ops/backup/nas-backup.sh /volume1/jarvisbuild-data/backups/encrypted
```

## 1. Hent og bygg

```
git pull
```

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build
```

**Koblet til utenfra (hytta, mobilnett)?** Mister PuTTY forbindelsen midt i bygget, kan bygget dø. Kjør det da i bakgrunnen i stedet for kommandoen over:

```
sudo -v
```

```
nohup sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build > /tmp/jarvis-update.log 2>&1 &
```

```
tail -f /tmp/jarvis-update.log
```

Ctrl+C stopper bare `tail`, ikke bygget. Ved neste prompt står det `[1]+ Done …` når bygget er ferdig (etter en frakobling: se `tail -20 /tmp/jarvis-update.log`). Står det `Stopped` (sudo ville ha passord): kjør `fg`, skriv passordet og la bygget gå ferdig i forgrunnen.

**Forventet:** bygget går gjennom, `migrate` avslutter med kode 0, api og worker starter.
**Avvik å melde fra om:** `migrate` feiler. Feilen er da sannsynligvis `violates foreign key constraint … _tenant` – en eksisterende rad krysser tenant. **Fjern ikke nøkkelen**; lim inn hele feilmeldingen, så finner vi raden.

## 2. Tjenester oppe

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml ps -a
```

**Forventet:** `api` og `worker` kjører (api healthy), `postgres` healthy, og `migrate` og `db-bootstrap` står som **Exited (0)** (`ps -a` viser også avsluttede engangsjobber; `ps` alene skjuler dem og viser dermed ikke at migrasjonene gikk bra).
**Observert 2026-10-08:** akkurat dette. `api`, `voice-gateway`, `browser-gateway` og `postgres` healthy, `worker` Up (workeren har ingen helsesjekk), `migrate` og `db-bootstrap` Exited (0).

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
JARVIS_BACKUP_DIR=/volume1/jarvisbuild-data/backups/encrypted ops/acceptance/nas-ua0-gate.sh
```

**Forventet:** ingen FAIL. Backup-sjekken C10 er PASS med mappen satt (uten `JARVIS_BACKUP_DIR` er den UNKNOWN). WARN og UNKNOWN regnes ikke som bestått. C06 (lokal modell) er FAIL hvis PC-en med Ollama er av, og C07 er UNKNOWN uten chat siste døgn – begge er miljø, ikke oppdateringen.
**Observert 2026-10-08 (etter oppdateringen):** 10 PASS / 2 WARN / 0 UNKNOWN / 0 FAIL (sist: 9 / 2 / 1, uten backup-mappe satt). C08 WARN: 1 av 28 lokale modellkall feilet siste døgn (årsak ikke undersøkt). C09 WARN: `constitution_unsigned`, kjent og ikke fra oppdateringen (Safety Constitution er ikke signert av eier ennå, `docs/runbooks/EV0_CONSTITUTION_SIGNING.md`).
Evidensfilen i `ops/acceptance/out/` ble **ikke** skrevet på NAS-en (mappen eies trolig av root etter en tidligere `sudo`-kjøring), selv om den gamle versjonen av skriptet påsto det. Nå advarer skriptet og viser rettelsen: `sudo chown -R $(id -un):$(id -gn) ops/acceptance/out` (eller sett `JARVIS_ACCEPTANCE_OUT_DIR`). Utdataene på skjermen er evidensen.

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
