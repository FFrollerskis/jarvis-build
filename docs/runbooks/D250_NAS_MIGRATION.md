# D-250: Flytte Jarvis fra dev-PC til UGREEN-NAS (Trinn 1)

**Status:** Utført av Tobias selv via SSH, PC og NAS er fysisk maskinvare denne sesjonen ikke har
tilgang til. Dette dokumentet er oppskriften; se D-250 i `DECISIONS_AND_ASSUMPTIONS.md` for
begrunnelse.

**Prinsipp (DEPLOYMENT_STRATEGY.md §1/§7):** stacken er bevisst bygget portabel - ren Docker Compose,
ren Postgres, ingen hardkodede maskin-/stier. Bekreftet ved kildekode-gjennomgang (2026-09-23): ingen
Windows-/PC-spesifikke stier i `infra/local/docker-compose.yml`, `api.Dockerfile` eller
migrasjonsfilene. `docker-compose.yml` skal derfor kjøre **uendret** på NAS-en.

**Ingen deploy av Tier 1-tjenester uten fersk backup (DEPLOYMENT_STRATEGY.md §4) - trinn 1 er
IKKE valgfritt.**

## Forutsetninger

- SSH-tilgang til BEGGE maskiner (PC-en som kjører stacken i dag, og NAS-en).
- `docker`/`docker compose` (v2) installert og fungerende på NAS-en (bekreftet av Tobias).
- Git-tilgang til `tsworkflow/jarvisbuild` fra NAS-en (samme måte som på PC-en).

## Trinn 1 - Full backup FØR noe røres

Kjør PÅ PC-EN (der stacken kjører i dag), fra repo-roten:

```powershell
# Full pg_dumpall - ALLE databaser i clusteret (jarvis, infisical, langfuse),
# ikke bare Tier-1-tabellene BackupService (modules/watchdog/src/backup.ts)
# dekker - den er et app-nivå supplement, ikke full migrerings-backup.
docker compose --env-file .env -f infra/local/docker-compose.yml exec -T postgres `
  pg_dumpall -U $env:JARVIS_DB_ADMIN_USER > jarvis-full-backup-$(Get-Date -Format yyyyMMdd-HHmmss).sql
```

Bekreft at filen faktisk har innhold (ikke tom pga. feil credential):

```powershell
Get-Item jarvis-full-backup-*.sql | Select-Object Name, Length
```

**Ikke fortsett før denne filen finnes og har en fornuftig størrelse** (flere hundre KB minst, avhengig
av hvor mye data du har).

## Trinn 2 - Overfør backup + `.env` til NAS-en

`.env` inneholder ekte hemmeligheter - overfør DIREKTE mellom dine egne maskiner (scp/SFTP), ALDRI
gjennom chat eller en tredjepartstjeneste:

```powershell
scp jarvis-full-backup-*.sql .env <bruker>@<nas-adresse>:/path/to/jarvisbuild-data/
```

## Trinn 3 - Klargjør repoet på NAS-en

Via SSH inn på NAS-en:

```bash
git clone https://github.com/tsworkflow/jarvisbuild.git
cd jarvisbuild
cp /path/to/jarvisbuild-data/.env .
cp /path/to/jarvisbuild-data/jarvis-full-backup-*.sql .
```

## Trinn 4 - Start KUN Postgres på NAS-en, gjenopprett dataene

```bash
docker compose --env-file .env -f infra/local/docker-compose.yml up -d postgres
# vent til healthy:
docker compose -f infra/local/docker-compose.yml ps postgres

docker compose --env-file .env -f infra/local/docker-compose.yml exec -T postgres \
  psql -U "$JARVIS_DB_ADMIN_USER" -d postgres < jarvis-full-backup-*.sql
```

`pg_dumpall`-filen inneholder egne `CREATE DATABASE`/`CREATE ROLE`-setninger for hele clusteret,
så dette gjenoppretter `jarvis`/`infisical`/`langfuse`-databasene og alle roller i ett steg - ikke
kjør `db-bootstrap`-tjenesten separat etterpå, den ville da prøve å opprette databaser som
allerede finnes (harmløst pga. dens `WHERE NOT EXISTS`-idiom, men unødvendig).

## Trinn 5 - Start hele stacken på NAS-en

```bash
docker compose --env-file .env -f infra/local/docker-compose.yml up -d --build
docker compose -f infra/local/docker-compose.yml ps
curl http://127.0.0.1:3010/health
```

## Trinn 6 - Verifiser dataene faktisk kom med

```bash
docker compose --env-file .env -f infra/local/docker-compose.yml exec postgres \
  psql -U "$JARVIS_DB_ADMIN_USER" -d jarvis -c "SELECT count(*) FROM messages;"
```

Sammenlign tallet mot det du forventer fra PC-en (kjør samme spørring der før du stopper PC-stacken,
hvis du ikke allerede har et referansetall).

## Trinn 7 - Pek tilgang mot NAS-en i stedet for PC-en

Installer Tailscale på NAS-en (samme fremgangsmåte som PC-en tidligere), og kjør DER:

```bash
tailscale serve --bg http://127.0.0.1:3010
tailscale serve --bg --https=3020 http://127.0.0.1:3020
```

Bruk NAS-ens `https://<nas-navn>.<tailnet>.ts.net/`-adresse i stedet for PC-ens gamle
`https://srby.tail3935f7.ts.net/` fra nå av.

## Trinn 8 - Stopp PC-stacken (kun etter at Trinn 5-7 er bekreftet OK)

```powershell
docker compose --env-file .env -f infra/local/docker-compose.yml down
```

**IKKE** `down -v` - behold PC-ens Docker-volum uberørt som ekstra sikkerhetsnett i noen dager før
du eventuelt rydder det.

PC-en er etter dette utviklings-/GPU-maskin igjen (DEPLOYMENT_STRATEGY.md §2 Trinn 1), NAS-en er
24/7-basen.

## Rollback

Data uberørt på PC-en (Trinn 8 fjerner aldri volumet) - start PC-stacken igjen med samme
`docker compose up -d --build`-kommando som før, og pek Tailscale `serve` tilbake på PC-en, hvis noe
går galt på NAS-en.
