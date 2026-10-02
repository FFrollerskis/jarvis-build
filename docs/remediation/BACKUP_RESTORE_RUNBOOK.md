# Runbook – kryptert backup og restore-verifisering (JARVIS-007)

**Status (2026-10-02): `RESTORE_VERIFISERT` for ett sett.** Backup `jarvis-backup-20261002T211007Z` ble tatt på NAS-en og restore-verifisert på Tobias' Windows-PC (Git Bash + Docker Desktop): `ok: true`, tabeller og eksakte radtall lik manifestet for jarvis (130/9019), infisical (188/954) og langfuse (40/373). **Fortsatt åpent:** daglig cron, flere kopier utenfor NAS, nøkkel-escrow, full katastrofe-restore til produksjon, sletting av ukryptert dump i `backups/stray/`.

## Hva som dekkes

| Database | Innhold | Kommentar |
|---|---|---|
| `jarvis` | all app-data (128 tabeller) | RLS-roller kommer med i `globals` |
| `infisical` | vaultet (kryptert av `INFISICAL_ENCRYPTION_KEY`) | **Uten nøkkelen er dumpen ubrukelig** – se [INFISICAL_KEY_ESCROW.md](INFISICAL_KEY_ESCROW.md) |
| `langfuse` | LLM-traces | |
| `globals` | roller (`pg_dumpall --globals-only`) | trengs for RLS-policyer som peker på roller |

Alle filer er `age`-kryptert (`*.age`). Klartekst-dump skrives aldri til disk. `manifest.json` har tabellnavn og eksakte radtall (tatt i samme snapshot som dumpen) – aldri radinnhold.

## Forutsetninger (én gang)

* På NAS-en (verten): `docker` og `node` (v18 forventes å fungere, ikke verifisert). `age` trengs **ikke** på verten: `nas-backup.sh` bruker `age-docker.sh` (engangs-container, D-370) når `age` mangler. Restore-verifisering (§5) gjøres på PC og krever `age` der.
* En age-nøkkelfil lages **på en annen maskin enn NAS-en** (PC eller offline):
  ```bash
  age-keygen -o jarvis-backup-identity.txt        # PRIVAT – oppbevares offline, aldri på NAS-en, aldri i repoet
  grep "public key" jarvis-backup-identity.txt     # age1... = OFFENTLIG nøkkel
  ```
* På NAS-en lagres kun den **offentlige** nøkkelen: `echo 'age1…' > ~/.jarvis-backup-recipient`

## 1. Ta backup (NAS)

```bash
cd <jarvisbuild-mappen>
ops/backup/nas-backup.sh /volume1/jarvis-backups
```
Skriver `/volume1/jarvis-backups/jarvis-backup-<UTC-tid>/` (mappe 0700, filer 0600), fjerner komplette sett eldre enn 30 dager (det nyeste beholdes alltid) og feiler hvis nyeste backup er eldre enn 25 t.

Manuelt, uten wrapper:
```bash
export JARVIS_DB_ADMIN_PASSWORD="$(grep -E '^JARVIS_DB_ADMIN_PASSWORD=' .env | cut -d= -f2-)"
export JARVIS_BACKUP_AGE_RECIPIENT="$(cat ~/.jarvis-backup-recipient)"
node ops/backup/jarvis-backup.mjs backup --mode docker --compose-file infra/local/docker-compose.yml --out /volume1/jarvis-backups
```

## 2. Kopier ut av NAS-en (`BLOCKED_EXTERNAL`: mål må velges av Tobias)

Én kopi på samme volum er ingen backup. Velg et mål *utenfor* NAS-en (PC, annen vert eller bucket) og kopier **krypterte** sett dit, f.eks.:
```bash
rsync -a --partial /volume1/jarvis-backups/ <bruker>@<annen-vert>:/<sti>/jarvis-backups/
```
Settene er kryptert – overføring og lagring trenger ingen ekstra hemmelighet.

## 3. Skedulering (cron på NAS-en)

```cron
17 2 * * * cd <jarvisbuild-mappen> && ops/backup/nas-backup.sh /volume1/jarvis-backups >> /volume1/jarvis-backups/backup.log 2>&1
```
Ferskhetssjekk (for overvåking): `node ops/backup/jarvis-backup.mjs status --out /volume1/jarvis-backups --max-age-hours 25` → exit 3 hvis for gammel.

## 4. Nøkkel-escrow

Før første backup regnes som gyldig: følg [INFISICAL_KEY_ESCROW.md](INFISICAL_KEY_ESCROW.md) og oppbevar privat age-nøkkel offline på minst to steder.

## 5. Bevis restore (på en annen maskin enn NAS-en)

Kopier ett sett og den private nøkkelen til en maskin med Docker + bash (f.eks. PC via WSL):
```bash
ops/backup/nas-restore-verify.sh /sti/til/jarvis-backup-<tid> /sti/til/jarvis-backup-identity.txt
```
Skriptet starter en **engangs-Postgres-container** (samme pinnede image som compose, `tmpfs`), restorer roller + alle tre databaser dit, sammenligner tabellinventar og **eksakte radtall** mot manifestet, og fjerner containeren. Det rører aldri produksjonsdatabasen og nekter å restore til kilde-serveren. Exit `0` = verifisert, `2` = avvik, ellers feil. Utdata er navn og tall – aldri radinnhold.

**Først når dette har gått grønt mot et sett tatt fra NAS-en, føres `restore-verifisert` inn i `PHASE_1_GATE.md` og `FINDINGS_LEDGER.md` (JARVIS-007).**

## Kjente begrensninger (åpne – ikke del 1)

* Restore gjenoppliver **slettede data** (GDPR-sletting) – ingen mekanisme re-anvender slettinger etter restore (JARVIS-030).
* Migrator tar ikke backup før migrasjon og har ikke lås/checksum (JARVIS-075).
* Ingen ekstern dead-man-watchdog (JARVIS-041); en feilet cron-kjøring varsler ingen.
* Fullstendig katastrofe-restore til produksjon (stoppe api/worker, restore, starte) er ikke øvd og ikke skriptet her – kun *verifisering* mot scratch.
