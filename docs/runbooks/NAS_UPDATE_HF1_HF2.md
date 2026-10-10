# NAS-oppdatering HF1/HF2 (byggeprogrammet etter D-450)

Sjekkliste for oppdateringen som tar NAS-en fra «UA-0 + remedieringen» til alt som ble bygget i HF1/HF2-programmet (job-runner, backup-drift, GitHub-App, Value Center, kontrollsentre,
finans D-kjede, AI Mesh, kunnskapskilder, Business OS, hendelsesløkke/cloud-mål). **Alt nytt er `DORMANT` (av) til du slår det på**; oppdateringen endrer derfor ingenting du bruker i dag
utenom det som står under «Atferdsendringer». Ingenting under er kjørt på NAS i byggemiljøet – det som står under «Forventet» er hva koden og testene sier, ikke observert drift.

Alle kommandoer kjøres fra `/volume1/jarvisbuild-data/jarvisbuild`. Innlogging (PuTTY/Tailscale) og innrullering av nettleser står i [NAS_UPDATE_2026-10-07.md](NAS_UPDATE_2026-10-07.md) – de er uendret.
Etter oppdateringen: kjør porten i punkt 5, og ta så den felles økten i [VERIFICATION_SESSION_HF1_HF2.md](VERIFICATION_SESSION_HF1_HF2.md). Hva bare du kan gjøre: [../OWNER_ACTIONS_HF1_HF2.md](../OWNER_ACTIONS_HF1_HF2.md).

## 0. Før du starter

1. **Sjekk hva som er merget:** `git fetch && git log --oneline origin/main -40`. Oppdateringen forutsetter at PR-ene i «Hva er nytt» under står i historikken (merge-commit per PR). Står en av dem ikke der, hopp over raden og dens migrasjon.
2. **Ta backup først** (krypterte sett; se [BACKUP_RESTORE_RUNBOOK](../remediation/BACKUP_RESTORE_RUNBOOK.md)):

```
ops/backup/nas-backup.sh /volume1/jarvisbuild-data/backups/encrypted
```

3. Noter dagens commit: `git rev-parse --short HEAD` (tilbakerulling, se «Hvis noe går galt»).

## 1. Hent og bygg

```
git pull
sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build
```

Bygget kan ta lang tid på NAS-en. Kjør det i bakgrunnen så SSH-forbindelsen ikke avbryter det:

```
nohup sudo docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build > /tmp/jarvis-update.log 2>&1 &
tail -f /tmp/jarvis-update.log
```

`migrate`-tjenesten kjører migrasjonene (navnebasert – hull i nummerrekken og rekkefølge på tvers av PR-er er ikke et problem). Ny kode krever ingen nye `.env`-verdier for å starte: alle nye variabler er valgfrie og AV som standard.

## 2. Tjenester oppe

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml ps -a
```

Forventet: `postgres`, `api` og `worker` `running`/`healthy`; `migrate` avsluttet med kode 0. Feiler `api` ved oppstart, les `docker compose logs --tail 100 api` – en ugyldig verdi i en NY variabel stopper oppstarten med en
melding som navngir variabelen (fail closed), aldri en stille delvis konfigurasjon.

## 3. Migrasjonene er anvendt

Alle filer i `modules/core/src/db/migrations/` skal stå i `schema_migrations`. Porten i punkt 5 sjekker det (`H02_migrations_applied`); manuelt:

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml exec -T postgres sh -c 'psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-jarvis}" -tA -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 12"'
```

## 4. Hva er nytt (alt `DORMANT` med mindre noe annet står)

| WP | Hva | Migrasjon | Slik slår du det på | Detaljer |
|---|---|---|---|---|
| C1 | Vertsside job-runner for kodejobber (D-32/Q-45a): Docker-gruppe-tjeneste, verifisert git-bundle-publisering, egress-proxy, `expected_sha` | – | `JARVIS_JOB_RUNNER=host` + override-filen `infra/job-runner/docker-compose.job-runner.yml` + installasjon på vertsmaskinen | [JOB_RUNNER.md](JOB_RUNNER.md) |
| C2 | Planlagt backup, restore-verifisering, off-site, ekstern heartbeat, statusfil til selvdiagnosen | – | cron-oppføring + `infra/backup/docker-compose.backup-status.yml` + `JARVIS_BACKUP_STATUS_FILE`; off-site-mål og heartbeat-URL er dine valg | [BACKUP_RESTORE_RUNBOOK](../remediation/BACKUP_RESTORE_RUNBOOK.md) |
| C3 | GitHub-App-autentisering (korte, repo-scopede tokens) i stedet for PAT | – | `JARVIS_GITHUB_APP_ID` + `JARVIS_GITHUB_APP_INSTALLATION_ID` + nøkkel i vaulten | [GITHUB_APP.md](GITHUB_APP.md) |
| C4 | Value Center: bruksmetrikk per verdiløkke, V2 oppfølgingsvarsel (Telegram), V3-beredskap, V5-forslag | – | V2: `JARVIS_V2_PUSH_ENABLED`; V5: `JARVIS_V5_PROPOSALS_ENABLED`; V3 sover alltid | [WPC4_VALUE_CENTER.md](WPC4_VALUE_CENTER.md) |
| H0 | Kontrollsentre (integrasjon, autoritet, AI, agenter, drift, verdi …) i dashbordet og `executive.get_control_center`; pause/tilbakekall av modellleverandør; avbryt jobb | – | Alltid på (kun eier); pause/tilbakekall er handlinger du velger | [WPH0_CONTROL_CENTER.md](WPH0_CONTROL_CENTER.md) |
| F1 | Finans D-kjede: de fire pengehandlingene kun via klasse D + step-up, eierens vei `/finance/actions`, avstemming | 099–101 | Leverandør-credentials per leverandør (alle `BLOCKED_EXTERNAL` til du leverer dem); `JARVIS_FINANCE_RECONCILE_HOUR` | [FINANCE_D_CHAIN.md](FINANCE_D_CHAIN.md) |
| D4 | AI Mesh: kandidatkjede med failover, Kimi/Hermes-verktøy, rådets forslagsvei, `executive.get_ai_mesh_status` | – | `JARVIS_CHAT_CANDIDATES`, `JARVIS_MESH_TOOLS_VERIFIED` (etter røyktest), `JARVIS_COUNCIL_PROPOSALS=on` | [AI_MESH_ACCEPTANCE.md](AI_MESH_ACCEPTANCE.md) |
| D1 | Kunnskapskilder (Drive Docs/Slides/Sheets, Obsidian, filmapper, GitHub, e-postvedlegg, transkripter), Q-26 påstandsverifisering, entitetsgraf | 086–088 | `JARVIS_KNOWLEDGE_SOURCES` + `JARVIS_KNOWLEDGE_FS_ROOTS` (+ montering); skriving: `JARVIS_KNOWLEDGE_CLAIM_WRITES=on` | [KNOWLEDGE_SOURCES.md](KNOWLEDGE_SOURCES.md) |
| D2 | Business OS: bedrifts-tenant, lead-/mulighetsoppdatering, produktbruk og churn, SLA/kalibrering | 089–091 | Tenant: `ops/nas/provision-business-tenant.sh`; `JARVIS_OWNER_EXTRA_TENANTS`; produktbruk: `JARVIS_PRODUCT_USAGE_TENANT_ID` + webhook-hemmelighet | [WPD2_BUSINESS_OS.md](WPD2_BUSINESS_OS.md) |
| E1 | Dev/Cloud: Cloudflare-connector (DNS/WAF/cache), Postgres-tiltak, Langfuse/Infisical som kontrollerte mål, hendelsesløkke med produsenter, `executive.get_infra_status` | 096–098 | Credentials per mål; produsenter: `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` | [CLOUDFLARE_CONNECTOR.md](CLOUDFLARE_CONNECTOR.md), [INFRA_CONTROLLED_TARGETS.md](INFRA_CONTROLLED_TARGETS.md), [INCIDENT_LIFECYCLE.md](INCIDENT_LIFECYCLE.md) |
| B1/B2 | Evolution-observatoriet (EV-0/1/2/3/4/5/7/8/9/10/12/16/17/19/21): rapport, radar, gylden suite, avhengighetsport | – | Radar: `JARVIS_RADAR_SOURCES` (inert uten) | `docs/CLOSURE_MATRIX_HF1_HF2.md` §1 |

Rader som ikke er merget på din commit (se punkt 0) gjelder ikke ennå.

## 4b. Atferdsendringer å se etter (de eneste som er på uten at du slår noe på)

- **Failover i vanlig prat:** hvis `JARVIS_CHAT_CANDIDATES` er satt, svarer neste kandidat når en feiler, og svaret får merknaden «Reservemodell brukt: …». Uten variabelen er oppførselen uendret.
- **Skyskjermen:** kunnskapstreff med `special`/helse holdes tilbake fra skymodeller; merknaden «Deler av kunnskapssøket ble holdt tilbake …» kan dukke opp i svar når kunnskapskilder er i bruk.
- **Pengehandlinger:** godkjenning av de fire pengehandlingene krever step-up (enhetssignert økt); en eksisterende ventende bekreftelse for dem må godkjennes på nytt fra en signert økt.
- **Kontrollsentre:** nye lesinger/handlinger i dashbordet er kun for den suverene eieren med signert enhetsøkt.
- **Hendelser og skymål (E1):** overgang, reparasjon og driftsoversikt for hendelser (`/incidents/transition|repair`, `/infra/overview`) og alle skymål-mutasjoner (Cloudflare, Postgres-tiltak, Infisical-rotasjon) krever den suverene eieren, og mutasjonene i tillegg en enhetssignert økt (ikke tale/Telegram/system). `executive.get_infra_status` ligger bare på web-chatten og velges kun når du spør om drift, hendelser eller skyen. Ingenting av dette endrer noe før en skymål-credential er satt.
- **Sensitivitet:** klassifiseringen leser nå en normalisert utgave av teksten (usynlige tegn, bredformat, spredte bokstaver) og kjenner «cancer». Noe flere meldinger kan derfor låses til lokal modell.

## 5. Akseptanseportene

```
JARVIS_BACKUP_DIR=/volume1/jarvisbuild-data/backups/encrypted ops/acceptance/nas-hf1-hf2-gate.sh
```

Porten kjører UA-0-porten først (`H01`), og måler så migrasjoner, RLS, hvilke dormante funksjoner som er på, job-runner, backup-status, sveipfeil siste døgn, tilstanden til hendelser/kunnskap/Business OS, og
om det står hemmelighetsformer i loggene (full skanning med evidens-opptakerens mønsterliste, `record-evidence.mjs --scan`; krever `node` på verten – uten den faller H12 tilbake til en forenklet liste og gir `WARN`, aldri `PASS`). `PASS` betyr bare at målingen var som forventet akkurat nå; `WARN` og `UNKNOWN` er IKKE bestått (UA-0-linjer som ikke er `PASS` skrives ut med prefikset `UA-0>`). `INFO` er opplysninger. Exit 0 = ingen `FAIL`, minst én `PASS` og ikke flere `UNKNOWN` enn `PASS`, 1 = minst én `FAIL`, 2 = docker/compose svarer ikke (kjør som en bruker med docker-tilgang, for eksempel med `sudo`), 3 = de fleste sjekkene kunne ikke bekreftes (ingen `PASS`, eller flere `UNKNOWN` enn `PASS`). Kjør aldri porten med `bash -x`. Den skriver `ops/acceptance/out/nas-hf1-hf2-gate-<tid>.md` – eies mappen av root
(etter en tidligere `sudo`), advarer scriptet og viser hvordan du retter det. **Lim aldri tokens eller nøkler inn i chat.** Ta utdataene med til den felles økten.

## 6. Kostnad og logger etter noen dager

```
sudo docker compose --env-file .env -f infra/local/docker-compose.yml logs --since 24h api worker | grep -E "_sweep_failed|knowledge_source_failed|knowledge_source_timeout|open_loop_sweep_tenant_failed|product_usage_purge_failed"
```

Ingen linjer = ingen feilede sveip. Sjekk også modellkostnad per leverandør (som i NAS_UPDATE_2026-10-07 §7) – failover og Kimi/Hermes kan flytte kostnad mellom leverandører.

## Hvis noe går galt

- **Tilbakerulling:** `git checkout <commit fra punkt 0>` og samme `up -d --build`. Nye migrasjoner reverseres ikke automatisk; gammel kode ignorerer de nye tabellene og kolonnene (de er additive). Unntak: migrasjon 099–101 (F1) legger til en DB-trigger som hindrer endring av
  beløp/valuta/mottaker på pengeintensjoner – gammel kode har ingen slik endring, så den fortsetter uforstyrret.
- **Hver ny funksjon har sin egen av-bryter:** fjern variabelen (eller sett den til `off`/tom) og start `api`/`worker` på nytt. Kill switch (`/infra/pause`) stanser all utførelse uten omstart.
- **Rapporter nøyaktig:** hvilket steg, hvilken melding (uten hemmeligheter), og `git rev-parse --short HEAD`. Gjett ikke; si «ikke observert» for det du ikke har kjørt.
