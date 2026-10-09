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


---

# 6. Planlagt drift, off-site-kopi, ekstern heartbeat og restore-drill (WP-C2, OPS-RUNTIME / Fase 10)

**Status (2026-10-09): `BUILT` + `DORMANT`, `NOT VERIFIED` på NAS.** Alt i dette avsnittet er bygget og testet mot ekte `pg_dump`/`pg_restore`/`age`, to Postgres-klynger, en lokal heartbeat-server og falske `rclone`/`rsync`-argv-tester - men **ingenting er kjørt på den ekte NAS-en, mot en ekte off-site-leverandør, med ekte rclone/rsync/ssh, med Docker, eller på Windows-PC-en.** Off-site, heartbeat og restore-verifisering er **AV til du setter dem** (ingen env = ingen utgående kall, og statusen sier ærlig `not_configured`). `OPS-RUNTIME` er først lukket når §6.7 er kjørt grønt på de ekte maskinene.

| Del | Bygget | Står igjen (eierens handling) |
|---|---|---|
| Planlagt backup (forfalt-løper, lås, retensjon, statusfil) | `ops/backup/schedule.mjs` + `nas-schedule.sh` | Installer cron/systemd (§6.2) og fjern den gamle cron-linjen |
| Off-site-kopi (rclone / rsync+ssh / lokal sti) | `ops/backup/lib/offsite.mjs` | **`BLOCKED_EXTERNAL`: du velger mål** (§6.3) |
| Ekstern heartbeat (backup + API-oppetid) | `lib/heartbeat.mjs`, `apps/api/src/heartbeat-sender.ts` | **`BLOCKED_EXTERNAL`: du velger/oppretter monitor** (§6.4) |
| Backup-status i selvdiagnosen | `apps/api/src/backup-status.ts` | Monter statusmappen `:ro` (§6.5) |
| Restore-drill + målt RTO/RPO | `acceptance-ops.sh drill` | Kjør på maskinen med den private nøkkelen; fyll inn mål (§6.6) |

## 6.1 Slik henger det sammen

* **Ett tikk hvert 15. minutt** (`ops/backup/schedule.mjs tick`) avgjør selv hva som er forfalt, ut fra settene på disk (manifestet er autoriteten) og `backup-status.json`. Et tikk uten forfall er **stille** (ingen cron-mail). Det samme tikket: tar backup (eksisterende `jarvis-backup.mjs` i en egen prosess med tidsavbrudd), håndhever retensjon, kopierer off-site, restore-verifiserer, pinger heartbeat og skriver status.
* **Roller** (`--roles backup,offsite,verify`, standard alle): på NAS-en er `verify` `not_configured` fordi privatnøkkelen **ikke** skal ligge der (setter du `JARVIS_BACKUP_VERIFY_IDENTITY_FILE` der likevel, kjører den - ikke anbefalt). Maskinen som holder den private age-nøkkelen (PC/offline-vert) kjører `verify`, helst med `JARVIS_BACKUP_VERIFY_SOURCE=offsite` - da bevises også at off-site-kopien er brukbar. Den sender en kvittering (`restore-verify-report.json`) til NAS-en (§6.6).
* **Filer** (alt i `<backup-mappe>` = `/volume1/jarvisbuild-data/backups/encrypted` i NAS-oppsettet, mappe 0700): `jarvis-backup-<UTC>/` (settene, som før) · `backup-status.json` (intern tilstand, 0600, atomisk) · `.backup-schedule.lock` (lås med foreldet-deteksjon) · `restore-verify-report.json` (kvittering) · `<JARVIS_BACKUP_STATUS_EXPORT_DIR>/backup-status.json` (offentlig, 0644, KUN oppramsede verdier - dette er den eneste filen API-containeren ser).
* **Idempotent og sameksistens:** et sett tatt av den gamle `nas-backup.sh`-cronen teller som ferskt. Begge kan stå samtidig (gir bare ekstra sett), men fjern den gamle når den nye virker.
* **Exit-koder** (`schedule.mjs`, for cron-mail/overvåking): `0` ok / ingenting forfalt · `1` konfig- eller intern feil · `2` backup feilet · `3` backup er **forfalt** (> 1,5 × intervall) uten at tikket tok den (f.eks. i backoff) · `4` restore-verifisering feilet · `5` off-site feilet · `6` off-site ikke satt opp (kun `offsite-check`). Prioritet ved flere feil: `2` > `4` > `5` > `3`.
* **Valgfrie delsystemer stopper aldri backupen:** en skrivefeil i `JARVIS_BACKUP_OFFSITE_*`/`VERIFY_*` gir exit `5`/`4` med feilkoden `offsite_config_invalid`/`verify_config_invalid` **etter** at backupen er tatt. Kjernekonfig (mappe, roller, intervall) er streng og gir exit `1` før noe kjører.
* **Retensjon:** komplette sett eldre enn `JARVIS_BACKUP_RETAIN_DAYS` (30) fjernes lokalt, det **nyeste beholdes alltid**, og ingenting slettes mens kjeden er stille (nyeste sett > 2 × intervall). Foreldreløse settkataloger uten manifest (backup som døde midt i) eldre enn 12 t ryddes. **Off-site slettes aldri av Jarvis** (`DEFERRED`, §6.3).

## 6.2 Installer planlagt kjøring (NAS)

```bash
cd /volume1/jarvisbuild-data/jarvisbuild && git pull
# 1. (valgfritt) legg inn innstillinger i .env - se blokken «PLANLAGT BACKUP» i .env.example. Uten noe kjører standardene: 24 t-intervall, 30 dagers retensjon.
# 2. Tørrkjøring: viser hva som ville skjedd, skriver ingenting
ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted tick --dry-run
# 3. Ett ekte tikk for hånd (tar backup hvis forfalt; ellers stille)
ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted tick --json
# 4. Status (exit 0 frisk · 3 backup forfalt · 4 restore · 5 off-site)
ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted status
```

Velg **én** planlegger (eksempler i `infra/backup/`, alle `NOT VERIFIED` på NAS-en):

* **cron:** `infra/backup/crontab.example` - `*/15 * * * * cd <repo> && ops/backup/nas-schedule.sh <backup-mappe> >> <backup-mappe>/../backup.log 2>&1` (sett `PATH` slik at `node` og `docker` finnes). **Fjern den gamle linjen** `17 2 * * * … nas-backup.sh …`.
* **systemd:** `infra/backup/jarvis-backup.service` + `jarvis-backup.timer` (se kommentarene i filene for installasjon; `systemctl list-timers jarvis-backup.timer`).
* NAS-ens egen oppgaveplanlegger (UGOS/DSM) kan kjøre samme kommando hvert 15. minutt som den brukeren som eier backup-mappen.

`nas-schedule.sh` leser `JARVIS_DB_ADMIN_*` og `JARVIS_BACKUP_*` fra `.env` (CRLF, anførselstegn og `# kommentar` tåles; **miljøet vinner** over `.env`), den OFFENTLIGE nøkkelen fra `~/.jarvis-backup-recipient`, velger `age-docker.sh` når `age` mangler (D-370), og kjører fra repoets rot så `docker compose` finner `.env`. Ingenting annet fra `.env` sendes videre, og ingen verdi skrives til skjerm.

## 6.3 Off-site-kopi - velg ÉN adapter (eierens valg, `BLOCKED_EXTERNAL`)

Kun **age-krypterte** filer forlater NAS-en: `*.dump.age`, `globals.sql.age` og `manifest.json.age` (manifestet, med tabellnavn og radtall, krypteres med samme offentlige nøkkel - klartekst-`manifest.json` og `SHA256SUMS` sendes ikke). Før kopiering nektes **hele settet** (høylytt, `offsite_ineligible`) hvis det finnes én ukjent fil (f.eks. en klartekst-dump), en `.age`-fil uten age-header, eller feil størrelse/SHA-256 mot manifestet. Etterpå verifiseres kopien mot manifestet; resultatet står i statusen (`sha256` / `size_only` / `checksum_dry_run`). To adaptere samtidig er en konfig-feil. Ingen generisk kommando-variabel finnes (og skal ikke innføres).

**(a) rclone** - verktøy, ikke leverandør: du konfigurerer din egen remote (bucket/sftp/drive/…) selv.
```bash
rclone config                                   # opprett remoten (du velger leverandør og logger inn)
rclone lsd mitt-mal:                            # test at den virker fra NAS-brukeren
rclone mkdir mitt-mal:jarvis/backups
echo 'JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE=mitt-mal:jarvis/backups' >> .env
```
Kun ferdig-konfigurerte remotes aksepteres (`navn:sti`; `:backend,param=…:`-strenger og shell-/glob-tegn avvises). Jarvis kjører `rclone copy` (aldri `sync`/`--delete`) med `--files-from-raw` over nøyaktig de krypterte filene, og `rclone lsjson --hash` for verifisering. Leverandører som ikke oppgir SHA-256 gir `size_only` (ærlig svakere) - kjør da av og til `rclone check --download --exclude manifest.json --exclude SHA256SUMS <lokalt sett> mitt-mal:jarvis/backups/<sett>` (klartekst-manifestet og sjekksumfilen sendes ikke, derfor `--exclude`; `NOT VERIFIED` mot en ekte remote). Rclone-passord/konfig-env (`RCLONE_*`) videreføres til rclone; DB-passordet gjør det aldri.

**(b) rsync over ssh til en annen vert** - kun nøkkelbasert, `BatchMode=yes`, `StrictHostKeyChecking=yes`:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/jarvis_backup -N ""                       # som NAS-brukeren
ssh-copy-id -i ~/.ssh/jarvis_backup.pub backup@annen-vert.lan              # eller legg nøkkelen inn manuelt
ssh -i ~/.ssh/jarvis_backup backup@annen-vert.lan 'mkdir -p /srv/jarvis'   # basestien MÅ finnes (rsync lager bare siste katalog)
ssh-keyscan -t ed25519 annen-vert.lan >> ~/.ssh/known_hosts_jarvis         # SJEKK fingeravtrykket mot verten selv før du stoler på det (ssh-keygen -lf)
cat >> .env <<'EOF'
JARVIS_BACKUP_OFFSITE_SSH=backup@annen-vert.lan:/srv/jarvis
JARVIS_BACKUP_OFFSITE_SSH_KEY=/home/<nas-bruker>/.ssh/jarvis_backup
JARVIS_BACKUP_OFFSITE_SSH_KNOWN_HOSTS=/home/<nas-bruker>/.ssh/known_hosts_jarvis
EOF
```
Verten og brukeren kan ikke begynne med `-`, stien må være absolutt uten mellomrom/`..`. Bruk et `Host`-alias i `~/.ssh/config` for ikke-standard port. Verifisering = `rsync --checksum --dry-run --itemize-changes` (tomt svar = identisk). Begrens gjerne nøkkelen på mottakeren til katalogen (f.eks. `rrsync`) - **`NOT VERIFIED`** at det fungerer sammen med `--list-only`/`--dry-run`.

**(c) lokal sti (USB/annen disk)** - krever en **markørfil** og en **annen enhet** enn backup-mappen, så en avmontert disk ikke «lykkes» ved å skrive til systemdisken:
```bash
mount | grep /mnt/usb                                   # disken er montert
mkdir -p /mnt/usb/jarvis && touch /mnt/usb/jarvis/.jarvis-offsite-target
echo 'JARVIS_BACKUP_OFFSITE_LOCAL_DIR=/mnt/usb/jarvis' >> .env
```
Kopien skrives til en midlertidig katalog, sjekksummeres, og publiseres med `rename`. Et eksisterende sett med avvikende innhold **overskrives aldri** (feiler høylytt). `JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE=true` er kun for bevisste unntak.

**Verifiser (alle adaptere):**
```bash
ops/backup/nas-schedule.sh <backup-mappe> tick --force-offsite --json     # sender nyeste sett nå
ops/backup/nas-schedule.sh <backup-mappe> offsite-check                    # leser fjernmålet, sammenligner mot manifestet; exit 0 / 5 / 6 (ikke satt opp)
```

**Retensjon av off-site-sett er `DEFERRED` og manuell:** Jarvis sletter aldri fjerndata (CLAUDE.md regel 8). Bruk leverandørens livssyklusregler (f.eks. «slett objekter eldre enn 90 dager»), eller rydd for hånd. Uten det vokser off-site ubegrenset.

**Hent tilbake fra off-site (katastrofe) - manuelt, uten Jarvis:**
```bash
rclone copy mitt-mal:jarvis/backups/jarvis-backup-<UTC> ./hentet/jarvis-backup-<UTC>          # (a)
rsync -a -e 'ssh -i ~/.ssh/jarvis_backup' backup@annen-vert.lan:/srv/jarvis/jarvis-backup-<UTC>/ ./hentet/jarvis-backup-<UTC>/   # (b)
cp -a /mnt/usb/jarvis/jarvis-backup-<UTC> ./hentet/                                           # (c)
age -d -i <privat-nøkkel> -o ./hentet/jarvis-backup-<UTC>/manifest.json ./hentet/jarvis-backup-<UTC>/manifest.json.age
ops/backup/nas-restore-verify.sh ./hentet/jarvis-backup-<UTC> <privat-nøkkel>                  # beviser at settet kan gjenopprettes
```

## 6.4 Ekstern heartbeat (dead man's switch)

Du velger en tjeneste som tar imot en enkel `GET` og varsler deg ved **stillhet** (healthchecks.io-kompatibel tjeneste, Uptime Kuma push-monitor eller tilsvarende) - Jarvis binder seg ikke til noen. URL-en er selv en kapabilitet (nøkkelen står i stien): behandle den som en hemmelighet; den logges aldri (kun `https://vert`). Det sendes kun status - aldri innhold, aldri tenant-data. `https://` kreves (`http://` kun mot loopback). Redirect følges aldri.

**1) Backup-heartbeat** (opprett en *egen* sjekk i monitoren; periode = backup-intervallet, f.eks. 1 dag, + 4 t grace):
```bash
echo 'JARVIS_BACKUP_HEARTBEAT_URL=https://<din-monitor>/<nøkkel>' >> .env
# healthchecks.io-konvensjon: <URL>/start når jobben begynner, <URL> ved suksess, <URL>/fail ved feil.
# Annen konvensjon (f.eks. Uptime Kuma): sett også JARVIS_BACKUP_HEARTBEAT_START_URL og JARVIS_BACKUP_HEARTBEAT_FAIL_URL eksplisitt.
```
Pinget sendes **kun når et tikk faktisk gjør noe** (backup/off-site/verify): `start` → `success`, eller `fail` hvis noe feilet. Dermed varsler monitoren ved både en feilet backup (`/fail`) og en død cron/maskin (stillhet). En heartbeat som selv feiler påvirker aldri backupen; den vises i statusen (`heartbeat.last_ping_ok=false`).
Restore-verifisereren (PC) har sin **egen** `JARVIS_BACKUP_HEARTBEAT_URL` (en annen sjekk, periode ≈ 1 uke).

**2) API-oppetid** (`apps/api`, en annen sjekk; periode ≈ 3 × `JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC`, f.eks. 3 min ved 60 s, + 1-2 min grace):
```bash
echo 'JARVIS_UPTIME_HEARTBEAT_URL=https://<din-monitor>/<annen-nøkkel>' >> .env
echo 'JARVIS_UPTIME_HEARTBEAT_INTERVAL_SEC=60' >> .env       # 10..3600, standard 60
docker compose -f infra/local/docker-compose.yml up -d api
```
API-et pinger **kun mens en lokal selvsjekk består** (`/health`: databasen svarer OG prosessen svarer på sin egen port). Feiler selvsjekken sendes **ingenting** (ikke engang `/fail`) - stillheten er alarmen. Ugyldig URL/intervall stopper ikke API-et, men heartbeaten starter ikke (loggen sier `uptime_heartbeat_config_invalid`; monitoren varsler fordi pingene uteblir). Se `docker compose logs api | grep uptime_heartbeat`.

**Test (må gjøres av deg, `NOT VERIFIED`):** (1) kjør `acceptance-ops.sh nas` (§6.7) og se i monitoren at backup-sjekken fikk `start` og `success`; (2) stopp api (`docker compose stop api`) og bekreft at API-sjekken varsler innen perioden + grace; start igjen og bekreft at den blir grønn.

## 6.5 Backup-status i selvdiagnosen (API leser en skrivebeskyttet fil)

Skriptet skriver `backup-status.json` til en **egen mappe** (aldri selve backup-mappen med settene) som api-containeren monterer `:ro`:
```bash
mkdir -p /volume1/jarvisbuild-data/backups/status
echo 'JARVIS_BACKUP_STATUS_EXPORT_DIR=/volume1/jarvisbuild-data/backups/status' >> .env
ops/backup/nas-schedule.sh <backup-mappe> tick --json                    # skriver eksporten (0644, mappen 0755)
docker compose -f infra/local/docker-compose.yml -f infra/backup/docker-compose.backup-status.yml up -d api
```
Overstyringen monterer MAPPEN skrivebeskyttet og setter `JARVIS_BACKUP_STATUS_FILE=/var/lib/jarvis-backup-status/backup-status.json` (en fil-montering ville pekt på den gamle, slettede inoden etter atomisk skriving). Spør Jarvis «hva er galt med deg?»: området **Backup** viser nå alder på siste backup, restore-verifisering, off-site og heartbeat. Terskler: siste backup > 1,5 × intervall = `DEGRADED`, > 3 × = `DOWN` (3 mislykkede forsøk på rad også); selve statusfilen eldre enn 1,5 × intervall (tikket kjører ikke) = `DEGRADED`; off-site eldre enn 2,5 × intervall eller feilet = `DEGRADED`; restore-verifisering feilet eller eldre enn 2 × intervallet (eller aldri bevist etter 2 intervaller) = `DEGRADED`; filen mangler/er ulesbar = `UNKNOWN` (aldri «frisk»). Ikke satt opp (off-site, heartbeat) vises som en **merknad**, ikke skjult. Filen er ubetrodd data: fritekst fra verktøyutdata når aldri selvdiagnosen (kun feilkoder oversatt i API-et).

## 6.6 Restore-verifisering og restore-drill (RTO/RPO)

Privatnøkkelen skal ikke ligge på NAS-en (§4), så restore-drillen kjøres på maskinen som holder den (PC). Den trenger Docker (engangs-Postgres, samme pinnede image som compose - sjekket av `check-containment.mjs`), `age`, `node`, og tilgang til settene: enten en kopi i en lokal mappe, eller off-site-målet.

**Manuell drill (anbefalt første gang) - fra off-site:**
```bash
# på PC-en (Git Bash/WSL/Linux); sett samme JARVIS_BACKUP_OFFSITE_* som på NAS-en (rclone fungerer best på Windows)
export JARVIS_BACKUP_OFFSITE_RCLONE_REMOTE='mitt-mal:jarvis/backups'
export JARVIS_RTO_TARGET_MINUTES=<ditt mål>   JARVIS_RPO_TARGET_HOURS=<ditt mål>     # valgfritt - uten dem vises tallene som INFO og sjekken er ikke bestått
ops/backup/acceptance-ops.sh drill ~/jarvis-drill --identity /sti/til/jarvis-backup-identity.txt --from-offsite
```
Hva skjer: nyeste sett hentes fra off-site til en midlertidig mappe, `manifest.json.age` dekrypteres med den private nøkkelen, **alle databaser og rollene** restores til en engangs-scratch-Postgres, tabellinventar og **eksakte radtall** sammenlignes mot manifestet, scratch og den hentede kopien fjernes. Produksjonsdatabasen røres aldri. Uten `--from-offsite` brukes nyeste sett i mappen.

**Sikkerhet ved restore-verifisering - settet er UBETRODD.** `age` er ikke autentisert: alle som kjenner den offentlige nøkkelen kan lage et sett som er konsistent mot sitt eget manifest (sjekksummene beviser ikke hvem som laget det). Derfor:

* **Scratch må være kastbar, og det kontrolleres.** Før noe skrives, leser verifisereren databaselisten på scratch-serveren og nekter hvis den har noe annet enn `postgres`/`template0`/`template1` og rester med prefikset `restore_verify_` (eller tabeller i `postgres`-databasen). En feilpekt `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` - produksjon under et annet navn (`localhost` mot `127.0.0.1`, DNS-alias, `docker-compose:postgres` mot `host:port`) - gir `verify_config_invalid` («scratch-serveren er ikke en tom, kastbar instans») i stedet for en restore mot produksjon. Dette er et sikkerhetsnett, ikke en lisens til å bruke en delt server.
* **Standard (anbefalt): engangs-container uten nettverk.** `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` tom → `nas-restore-verify.sh` starter en Postgres-container med `--network none` og kaster den etterpå (`NOT VERIFIED` mot en ekte Docker-daemon i byggemiljøet - `acceptance-ops.sh drill` på PC-en beviser det). Med en egen, varig scratch-server (`JARVIS_BACKUP_VERIFY_SCRATCH_HOST` satt) gjelder: **`pg_restore` kjører dumpens SQL som superuser på scratch-serveren** (en ondsinnet dump kan f.eks. kjøre `COPY … PROGRAM`). Custom-format-dumper skal derfor KUN restores til en instans du kan kaste - aldri en delt eller produksjonsnær server. Den kan **ikke** kombineres med `JARVIS_BACKUP_VERIFY_SOURCE=offsite` (konfig-feil `verify_config_invalid`): et sett fra fjernmålet har den svakeste tilliten.
* **`globals.sql` filtreres.** Rolle-filen dekrypteres til minnet og whitelist-filtreres før `psql` ser den: kun `SET`, `CREATE ROLE`, `ALTER ROLE … WITH/SET`, `GRANT rolle TO rolle`, `COMMENT ON ROLE` og `set_config('search_path')` slippes gjennom, enhver backslash (psql-metakommando som `\!`) nektes, og teksten gjenoppbygges fra de validerte delene. Alt annet (`CREATE TABLESPACE`, `DROP`, `COPY` ...) stopper verifiseringen med `verify_integrity` (trinn `globals`). **Roller restores uten passord-hasher** - scratch arver ikke produksjonens passord. Filteret beskytter verifisererens VERT (metakommandoer), ikke scratch-serveren mot dumpen: se punktet over.
* Manifestet valideres mot en lukket form før noe kjører (tabell- og databasenavn limes inn i SQL); avvik gir `verify_integrity` (trinn `manifest`).

**Planlagt drill på PC-en (ukentlig):** samme tikk med kun verify-rollen. Linux: `0 4 * * 1 cd <repo> && node ops/backup/schedule.mjs tick --out $HOME/jarvis-drill --roles verify`; Windows Oppgaveplanlegger (eksempel, `NOT VERIFIED`):
```
schtasks /Create /SC WEEKLY /D MON /ST 04:00 /TN "Jarvis restore-verify" /TR "\"C:\Program Files\Git\bin\bash.exe\" -lc \"cd /c/Users/<deg>/jarvisbuild && node ops/backup/schedule.mjs tick --out C:/Users/<deg>/jarvis-drill --roles verify\""
```
med disse satt som **miljøvariabler** i skallet som kjører oppgaven (`schedule.mjs` leser ikke `.env`; kun `nas-schedule.sh` gjør det, og den er skrevet for NAS-en): `JARVIS_BACKUP_VERIFY_IDENTITY_FILE`, `JARVIS_BACKUP_VERIFY_SOURCE=offsite`, `JARVIS_BACKUP_OFFSITE_*`, evt. egen `JARVIS_BACKUP_HEARTBEAT_URL`. Verify-rollen krever verken DB-admin-passordet eller den offentlige nøkkelen. Uten Docker kan en direkte scratch-server brukes (`JARVIS_BACKUP_VERIFY_SCRATCH_HOST/PORT/USER` + `JARVIS_SCRATCH_DB_PASSWORD`).

**Meld resultatet tilbake til NAS-en** (da viser selvdiagnosen der at restore er bevist, merket «meldt av ekstern verifiserer»): verifisereren skriver `restore-verify-report.json` (kun oppramsede verdier: sett, ok, tid, tabeller, rader, kilde) i sin state-mappe. Kopier den til NAS-ens state-mappe (standard: backup-mappen) som samme bruker som kjører tikket:
```bash
scp ~/jarvis-drill/restore-verify-report.json <nas-bruker>@<nas>:/volume1/jarvisbuild-data/backups/encrypted/
```
Rapporter datert i fremtiden (> 5 min) og eldre enn siste kjente forsøk ignoreres. Det er et *påstand fra din egen PC*, ikke en kryptografisk attestasjon.

**Mål-RTO/RPO - fyll inn (eier):**

| | Eierens mål | Målt (`acceptance-ops.sh drill`) | Dato | Merknad |
|---|---|---|---|---|
| **RPO** (maks datatap) | `____ t` | verste tilfelle = `JARVIS_BACKUP_INTERVAL_HOURS` + 15 min tikk (printes av `acceptance-ops.sh nas`, O08); målt = alderen på settet du gjenopprettet (D03) | | Off-site-RPO = alderen på nyeste *off-site*-sett |
| **RTO** (maks nedetid) | `____ min` | henting fra off-site + restore + verifisering til scratch (D02) | | **Dekker IKKE** stack-oppstart, ompeking av API/klienter, DNS/Tailscale, menneskelig tid - legg til for hånd |

Full katastrofe-restore til produksjon (stoppe api/worker, restore, starte, verifisere) er **fortsatt ikke skriptet eller øvd** (§Kjente begrensninger) - øv den manuelt én gang og før tiden inn i RTO-tabellen. Husk `INFISICAL_ENCRYPTION_KEY` fra escrow ([INFISICAL_KEY_ESCROW.md](INFISICAL_KEY_ESCROW.md)): uten den er den gjenopprettede `infisical`-databasen ubrukelig.

## 6.7 Akseptanse (OPS-RUNTIME) - ett script per maskin

```bash
# PÅ NAS-en: tvinger frem ÉN planlagt backup (samme kodevei som cron) og kontrollerer alt rundt
JARVIS_RPO_TARGET_HOURS=<mål>  ops/backup/acceptance-ops.sh nas /volume1/jarvisbuild-data/backups/encrypted
# PÅ maskinen med privatnøkkelen: restore-drill med målt RTO/RPO
JARVIS_RTO_TARGET_MINUTES=<mål> JARVIS_RPO_TARGET_HOURS=<mål> ops/backup/acceptance-ops.sh drill ~/jarvis-drill --identity <nøkkelfil> --from-offsite
ops/backup/acceptance-ops.sh report <backup-mappe>        # kun les status
```
| Sjekk | Beviser |
|---|---|
| `O01` | planlagt tikk tok ett sett (exit 0, handling `backup`) |
| `O02` | settet er ferskt (< 15 min), **alle** `.age`-filer har age-header, ingen klartekst/ukjente filer |
| `O03` | off-site-kopi finnes og stemmer mot manifestet (`NOT_CONFIGURED` hvis ingen adapter) |
| `O04` | heartbeat ble **mottatt** (HTTP 2xx) - *at den vises i monitoren bekrefter du selv* |
| `O05`/`O06` | statuseksporten finnes, er lesbar for andre (0644), og api-containeren kan lese den |
| `O07` | API-oppetids-heartbeat er startet uten feil i loggen - *stopp api og bekreft varselet selv* |
| `O08` | RPO verste tilfelle mot ditt mål |
| `D01`–`D04` | restore til scratch lik manifestet (tabeller + eksakte radtall), målt RTO, målt RPO, kvittering til NAS |

**Exit:** `0` = alt bestått · `1` = minst én `FAIL` · `3` = ingen `FAIL`, men noe er `NOT_CONFIGURED`/`UNKNOWN` - **ikke lukket**. Evidensen (uten hemmeligheter) skrives til `ops/acceptance/out/ops-acceptance-<modus>-<tid>.md` (git-ignorert); lim utskriften inn i chatten. `ops/acceptance/nas-ua0-gate.sh` er uendret (C10 sjekker fortsatt kun alder ≤ 25 t); en fremtidig `C13` kan lese `ops/backup/…/status --json`, men er bevisst ikke lagt inn her for å unngå konflikt med andre UA-0-endringer.

## 6.8 Feilsøking

| Symptom | Årsak / tiltak |
|---|---|
| Exit `1` med «JARVIS_BACKUP_AGE_RECIPIENT …» | mottakerfilen/variabelen mangler eller er en privat nøkkel (`AGE-SECRET-KEY-…` aksepteres aldri) |
| Exit `3` hver 15. min | backupen er forfalt og i backoff (30 → 60 → 120 → 240 min) - se `backup-status.json` (`last_error_code`) og loggen |
| Exit `5`, `offsite_config_invalid` | to adaptere satt, ugyldig `navn:sti`/`bruker@vert:/sti`, eller (lokal) manglende markørfil / samme enhet - meldingen sier hvilken |
| Exit `5`, `offsite_ineligible` | settet inneholder en ukjent/klartekst-fil eller en `.age`-fil uten age-header - **fjern filen**, ikke kopier |
| `Host key verification failed` | vertsnøkkelen er ikke i `JARVIS_BACKUP_OFFSITE_SSH_KNOWN_HOSTS` (`ssh-keyscan`, og verifiser fingeravtrykket) |
| Tikk gjør ingenting, «lock_held» (`--verbose`) | et annet tikk kjører; en lås fra en død prosess tas over automatisk, ellers etter `JARVIS_BACKUP_LOCK_STALE_MINUTES` |
| Exit `4`, `verify_config_invalid`, «ikke en tom, kastbar instans» | scratch-serveren har andre databaser enn `postgres`/`template*`/`restore_verify_*` (meldingen nevner noen av dem) - er `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` feilpekt? Bruk engangs-containeren (la variabelen stå tom) eller en egen, tom Postgres. **Aldri** «fiks» dette ved å tømme en server du ikke eier |
| Exit `4`, `verify_integrity`, «globals.sql nektes» / trinn `manifest` | rolle-filen eller manifestet har noe utenfor de kjente formene (`last_error` oppgir linjenummer og årsak, aldri innholdet). Er settet ekte (f.eks. egne tablespaces)? Undersøk settet FØR du endrer filteret; er det manipulert, regn off-site-målet som kompromittert |
| Gjenværende scratch-containere | `docker ps -a --filter name=jarvis-restore-scratch` → `docker rm -f` (kun hvis et tikk ble drept hardt) |
| Statusen i selvdiagnosen er `UNKNOWN` | eksportmappen er ikke montert / filen mangler - kjør `acceptance-ops.sh nas` (O05/O06) |

## 6.9 Ærlige begrensninger og hvordan de verifiseres

* **`NOT VERIFIED` i dette miljøet** (ingen NAS, Docker-daemon, rclone, rsync/ssh eller ekstern leverandør): `docker compose exec`-banen mot den ekte stacken, `age-docker.sh` på NAS, rclone/rsync/ssh mot et ekte mål, ekte heartbeat-leverandør, systemd/cron/Oppgaveplanlegger, Windows Git Bash-banen (`bash`-argumentene bruker `C:/…`-skråstrek, uprøvd), UGOS-spesifikk atferd. **Verifiser** med `acceptance-ops.sh nas` (NAS) og `drill --from-offsite` (PC) over; `JARVIS_ACCEPTANCE_DRY_RUN=1` lister sjekkene uten å kjøre noe.
* **Testet her** (`npx vitest run ops/backup/test modules/core/test/wpc2-backup-schedule-e2e.test.ts apps/api/test/wpc2-backup-status.test.ts apps/api/test/wpc2-heartbeat-sender.test.ts modules/executive/test/wpc2-backup-limitation.test.ts`): forfalt-logikk, lås (ekte flerprosess-kappløp), retensjon, backoff, off-site-forhåndssjekk og lokal sink, argv for rclone/rsync (opptaker), heartbeat mot lokal server og `guardedFetch`, hele kjeden backup → off-site → restore-verify → heartbeat mot to ekte Postgres-klynger med ekte `pg_dump`/`age`, API-leseren og selvdiagnosen.
* **Off-site-retensjon** er `DEFERRED`/manuell (§6.3). **Kryptografisk attestasjon** av verifisererens kvittering finnes ikke (kvitteringen er en påstand fra din PC). **Full produksjons-restore** er ikke skriptet. **Verifisering uten Docker på NAS** støttes bare med en direkte scratch-server. **Uptime-monitoren** (eierens tjeneste) er utenfor Jarvis: alarmen er kun så god som varslingskanalen du kobler til den.
