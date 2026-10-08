# NAS-oppdatering 2026-10-07 (D-427…D-438)

Sjekkliste for neste NAS-oppdatering. **Ingenting under er verifisert på NAS ennå** – det som står under «Forventet» er hva koden og testene sier, ikke observert drift. Kjør ett steg om gangen, lim inn utdata, og stopp ved første avvik.

**Merk:** punkter merket med migrasjon 078–082 og D-437/D-438 forutsetter at PR #286, #288 og #289 er merget før du oppdaterer. Sjekk `git log --oneline -15` etter `git pull`.

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

**Forventet (forutsetter at PR #286 er merget):** `080_tenant_scope_fk_rest.sql`, `079_tenant_scope_fk_money.sql`, `078_tenant_scope_fk_identity.sql` øverst.

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

## 7. Kostnad etter noen dager

```
sudo docker exec -it $(sudo docker ps -qf name=postgres) psql -U postgres -d jarvis -P pager=off -c "SELECT date_trunc('day', at AT TIME ZONE 'Europe/Oslo')::date AS dag, provider, model, count(*) AS kall, sum(amount_ore) AS ore, sum(input_tokens) AS inn FROM cost_events GROUP BY 1,2,3 ORDER BY 1 DESC, 5 DESC LIMIT 20;"
```

**Forventet:** `gemma_local` med 0 øre; Sonnet-rader med lavere øre per kall enn før (cache-treff).
Dagstak: når dagens sum overstiger 30 kr, får verktøyturer en fast merknad og går lokalt.

## Hvis noe går galt

- **Worker starter ikke etter D-434:** en handler mangler en nøkkel. Lim inn `logs worker`; nøkkelen legges i `WORKER_CONNECTOR_ENV` (`infra/local/service-env.mjs`).
- **Infisical-lesing feiler etter D-436:** sjekk at `INFISICAL_URL` er `http://infisical:8080` (vertsnavn uten understrek).
- **Tilbakerulling:** `git checkout 85b69c5` og samme `up -d --build`. Migrasjon 078–080 reverseres ikke automatisk. Gammel kode setter alltid `tenant_id` på radene sine, så komposittnøklene skal ikke stoppe den, men det er **ikke testet**. Migratoren rapporterer de nyere migrasjonene som «ukjente» (`unknown_applied`) uten å avbryte planen. Behold backupen fra steg 0 til alt er bekreftet.
