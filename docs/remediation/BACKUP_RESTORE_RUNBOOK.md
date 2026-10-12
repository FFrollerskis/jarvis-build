# Runbook – kryptert backup og restore-verifisering (JARVIS-007)

**Status (2026-10-02): `RESTORE_VERIFISERT` for ett sett.** Backup `jarvis-backup-20261002T211007Z` ble tatt på NAS-en og restore-verifisert på Tobias' Windows-PC (Git Bash + Docker Desktop): `ok: true`, tabeller og eksakte radtall lik manifestet for jarvis (130/9019), infisical (188/954) og langfuse (40/373). **Fortsatt åpent:** daglig cron, flere kopier utenfor NAS, nøkkel-escrow, full katastrofe-restore til produksjon, sletting av ukryptert dump i `backups/stray/`.

**Oppdatering 2026-10-12 (blokk 2, observert på NAS, håndlimt av eier, [evidens](../evidence/2026-10-12-hf-1-ops-runtime-nas.md)):** planlagt tikk er installert i cron (hvert 15. minutt som brukeren Jarvis; første cron-tikk 09:00:01Z), off-site rclone → Google Drive er sha256-bekreftet, statuseksporten er montert i api, og `acceptance-ops.sh nas` ga PASS=5 / FAIL=0 / ikke satt opp=3 (exit 3 = IKKE lukket). Den gamle nattjobben er fjernet. **Fortsatt åpent:** ekstern heartbeat (O04/O07), RPO/RTO-mål (Q-62), restore-drill fra off-site med privatnøkkel (D01-D04), nøkkel-escrow og rotering av Google-hemmeligheter (Q-61), og første naturlige backup fra cron (ventet 2026-10-13 ca. 09:23Z).

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
* **«Komplett sett»** = gyldig `manifest.json` OG hver fil manifestet lister finnes som vanlig fil, er ikke tom og har størrelsen manifestet oppgir. Et sett med manifest men manglende/avkortede filer (kopiert uten dumpene, slettet for hånd) er **hult**: det teller ikke som siste backup (neste backup tas), logges som `set_incomplete`, og røres aldri automatisk (restene kan være det eneste som er igjen). Sjekksummer verifiseres der filene brukes (off-site-forhåndssjekken og restore-verifiseringen).
* **Idempotent og sameksistens:** et sett tatt av den gamle `nas-backup.sh`-cronen teller som ferskt. Begge kan stå samtidig (gir bare ekstra sett), men fjern den gamle når den nye virker.
* **Exit-koder** (`schedule.mjs`, for cron-mail/overvåking): `0` ok / ingenting forfalt · `1` konfig- eller intern feil · `2` backup feilet · `3` backup er **forfalt** (> 1,5 × intervall) uten at tikket tok den (f.eks. i backoff) **eller låsen holdes av et hengt tikk** (se under) · `4` restore-verifisering feilet · `5` off-site feilet · `6` off-site ikke satt opp (kun `offsite-check`). Prioritet ved flere feil: `2` > `4` > `5` > `3`. Heartbeat: `success` sendes kun når tikket ender med exit `0` - ender det forfalt (`3`) eller feilet, går `/fail`.
* **Hengt kjede stopper aldri stille.** Hver off-site-operasjon mot en lokal sti (USB/NFS) har en frist (`JARVIS_BACKUP_OFFSITE_TIMEOUT_MINUTES`, totalt per kall), prosesser som ikke dør av `SIGKILL` gis det opp på, og **ett tikk har et tak** (summen av de påslåtte stegenes frister + 15 min; backup + 2 × off-site + verifisering, 375 min med standardene): overskrides det, registrerer en vaktbikkje feilen på steget som hang (`*_timeout`), sender `/fail`, **slipper låsen** og avslutter tikket - neste tikk går som normalt. Finner et tikk likevel en lås som har vært holdt i mer enn 2 × intervallet (og lenger enn tak-budsjettet), logges `lock_held_too_long` som feil og tikket avslutter med exit `3` i stedet for stille exit `0`. Husk at en **fryst** NFS-/USB-montering kan blokkere selve prosessen i kjernen (ikke avbrytbart fra Node): `TimeoutStartSec=` i systemd-eksempelet og lås-foreldelse (`JARVIS_BACKUP_LOCK_STALE_MINUTES`) er siste skanse. `NOT VERIFIED` mot en ekte hengt NFS/USB-montering - kun simulert med falske filsystemkall.
* **Valgfrie delsystemer stopper aldri backupen:** en skrivefeil i `JARVIS_BACKUP_OFFSITE_*`/`VERIFY_*` gir exit `5`/`4` med feilkoden `offsite_config_invalid`/`verify_config_invalid` **etter** at backupen er tatt. Kjernekonfig (mappe, roller, intervall) er streng og gir exit `1` før noe kjører.
* **Retensjon:** komplette sett eldre enn `JARVIS_BACKUP_RETAIN_DAYS` (30) fjernes lokalt - **høyst 3 per tikk, eldste først** (en advarsel `retention_prune_capped` varsler om flere) - men **de 7 nyeste, det siste restore-verifiserte og det siste off-site-bekreftede settet beholdes alltid** (de er det eneste beviset på at en restore virker og at en kopi finnes utenfor huset). Ingenting slettes mens kjeden er stille (nyeste sett > 2 × intervall), mens **off-site eller restore-verifisering har feilet** (`retention.last_skipped_reason` = `offsite_failing` / `verify_failing`: de lokale settene er da sikkerhetsnettet - prisen er at disken vokser til feilen er rettet), eller i et døgn etter et **langt gap** siden forrige tikk (NAS av eller klokken hoppet fremover; `time_gap_hold`, loggen sier `tick_gap_retention_hold`) - slik at en feil klokke kan rettes før noe slettes. **Statusfilen er også et vern (andre gjennomgang, M4):** er den borte, korrupt, tom, har feil skjema eller er for stor - og ved første kjøring uten status - er «siste verifiserte/off-site-bekreftede sett» og forrige tikk glemt, og en klokkehopp kunne slettet det siste beviset på at en restore virker. Retensjonen pauses da (`retention.last_skipped_reason` = `status_unusable`; `retention.status_reset_at` i statusfilen; `schedule.mjs status` viser `status_file.problem`; loggen sier `status_file_unusable`/`status_file_missing` og `retention_paused_status_unusable`) **til en vellykket restore-verifisering eller off-site-bekreftelse (også en flettet ekstern kvittering) er registrert** - da er beviset kjent og beskyttet igjen. Uten noen slik kilde (kun backup-rollen) finnes det ingenting å vente på, og pausen slippes etter et døgn (samme hold som ved et tikk-gap). Første kjøring går samme vei: ingenting slettes før et bevis finnes, men det blokkerer aldri for alltid. Retensjon kjører bare i tikk med `backup`-rollen (en PC som kun verifiserer sletter aldri sett). **Foreldreløse settkataloger** (uten `manifest.json`, eldre enn 12 t) ryddes kun hvis de er **helt tomme**, **etter alle pausene**, innenfor det samme taket (3 slettinger per tikk, sett først), aldri under navnet til siste verifiserte/off-site-bekreftede sett, og bare når `lstat` på `manifest.json` gir `ENOENT` - `EACCES`/`EIO`/`ESTALE` på en ustø NFS-/USB-montering betyr «vet ikke», og katalogen røres ikke (`orphan_check_unverified`). Fjerningen er `rmdir` (ikke rekursiv). En katalog uten manifest men MED innhold (typisk en avkortet dump etter en backup som døde midt i, kan være det eneste som er igjen) slettes aldri automatisk: den rapporteres som `orphan_set_has_data` hvert tikk til du har undersøkt og fjernet den for hånd. **Off-site slettes aldri av Jarvis** (`DEFERRED`, §6.3). NB: den gamle `nas-backup.sh` (`jarvis-backup.mjs backup --retain-days`) har fortsatt den enkle retensjonen uten disse vernene - fjern den gamle cronen når den planlagte kjører.

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
* **NAS (UGOS/Debian 12), observert 2026-10-12:** `crontab -e` og `crontab -` som vanlig bruker kan feile med `/var/spool/cron/: mkstemp: Permission denied` (da endres ingenting). Skriv ønsket crontab til en fil og installer den med sudo for brukeren; `grep -q` først, så du ikke installerer en tom liste hvis `crontab -l` feiler:
```bash
(crontab -l | grep -v 'nas-schedule.sh'; echo '<ny cron-linje>') > ~/crontab-ny.txt && grep -q 'nas-schedule.sh' ~/crontab-ny.txt && sudo crontab -u <bruker> ~/crontab-ny.txt && crontab -l
```

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
Kopien skrives til en midlertidig katalog (`.incoming-<sett>-<hex>`), sjekksummeres, og publiseres med `rename`. Et eksisterende sett med avvikende innhold **overskrives aldri** (feiler høylytt). `JARVIS_BACKUP_OFFSITE_LOCAL_ALLOW_SAME_DEVICE=true` er kun for bevisste unntak.

Kopien leser fra et *åpnet* håndtak (`O_NOFOLLOW`): en `.age`-fil som byttes ut med en symlenke eller klartekst etter forhåndssjekken avvises (`offsite_ineligible` / `offsite_verify_failed`), og ingenting opprettes i målet før første blokk har age-headeren. Før hver kopi rydder adapteren sine **egne** foreldede `.incoming-<sett>-<hex>`-kataloger (rester etter en kopi som døde midt i; eldre enn 12 t og 2 × `JARVIS_BACKUP_OFFSITE_TIMEOUT_MINUTES`) - bare nøyaktig det navnemønsteret, bare ekte kataloger, ellers slettes ingenting i målet (loggen sier `offsite_stale_incoming_removed`). Det samme gjelder `.verify-tmp-*`-arbeidsmapper i backup-mappen etter en avbrutt off-site-henting (`stale_tmp_removed`; eldre enn 12 t og tikk-budsjettet).

**Verifiser (alle adaptere):**
```bash
ops/backup/nas-schedule.sh <backup-mappe> tick --force-offsite --json     # sender nyeste sett nå
ops/backup/nas-schedule.sh <backup-mappe> offsite-check                    # leser fjernmålet, sammenligner mot manifestet; exit 0 / 5 / 6 (ikke satt opp)
```

**Henting fra off-site er begrenset (andre gjennomgang, L2).** Fjernmålet er ubetrodd, så restore-verifiseringen (`--verify-source offsite`, drillen) henter med et tak: hele settet må rime med 80 % av ledig plass der arbeidsmappen (`.verify-tmp-*` i backup-mappen) ligger (kan plassen ikke leses, gjelder 64 GiB), ellers feiler verifiseringen FØR noe kopieres (`verify_failed`). Den lokale adapteren kopierer dessuten bare filer som starter med age-headeren, mot størrelsen oppslaget så (vokser en fil, avbrytes kopien). rclone og rsync får `--max-size` per fil; en fil over taket hoppes over og settet feiler da integritetssjekken i stedet for å fylle disken (`NOT VERIFIED` mot ekte rclone/rsync).

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

Skriptet skriver `backup-status.json` til en **egen mappe** (aldri selve backup-mappen med settene) som api-containeren monterer `:ro`. Eksportmappen kan verken være backup-mappen, state-mappen (`JARVIS_BACKUP_STATE_DIR`) eller ligge inni/rundt dem (også via symlenke): det er en konfig-feil (`exit 1`, før noe kjører), fordi eksporten har samme filnavn som den interne `backup-status.json` og ellers ville overskrevet den - og vist de krypterte settene til api-containeren:
```bash
mkdir -p /volume1/jarvisbuild-data/backups/status
echo 'JARVIS_BACKUP_STATUS_EXPORT_DIR=/volume1/jarvisbuild-data/backups/status' >> .env
ops/backup/nas-schedule.sh <backup-mappe> tick --json                    # skriver eksporten (0644, mappen 0755)
docker compose -f infra/local/docker-compose.yml -f infra/backup/docker-compose.backup-status.yml up -d api
```
**Husk (observert 2026-10-12):** når eksporten er slått på må alle senere `up`/`--build`-kommandoer for api ha begge compose-filene og `--env-file .env` (`sudo docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/backup/docker-compose.backup-status.yml up -d api`). Ellers fjernes monteringen når api opprettes på nytt, og «Backup» i selvdiagnosen blir `UNKNOWN`.

Overstyringen monterer MAPPEN skrivebeskyttet og setter `JARVIS_BACKUP_STATUS_FILE=/var/lib/jarvis-backup-status/backup-status.json` (en fil-montering ville pekt på den gamle, slettede inoden etter atomisk skriving). API-et leser filen defensivt: `lstat` først og kun en vanlig fil (en FIFO, enhet, mappe eller **symlenke** i stedet for `backup-status.json` er uleselig - symlenker følges ikke), `O_NONBLOCK | O_NOFOLLOW`, og en frist på 5 s (`timeout` → området er `UNKNOWN`, aldri «frisk»). Et tidspunkt i filen som ligger mer enn 5 min FREM i tid (klokkeavvik mellom NAS og API, eller en endret fil) kan aldri bevise ferskhet: området blir `DEGRADED` med årsaken, aldri «0 t siden». Spør Jarvis «hva er galt med deg?»: området **Backup** viser nå alder på siste backup, restore-verifisering, off-site og heartbeat. Terskler: siste backup > 1,5 × intervall = `DEGRADED`, > 3 × = `DOWN` (3 mislykkede forsøk på rad også); selve statusfilen eldre enn 1,5 × intervall (tikket kjører ikke) = `DEGRADED`; off-site eldre enn 2,5 × intervall eller feilet = `DEGRADED`; restore-verifisering feilet eller eldre enn 2 × intervallet (eller aldri bevist etter 2 intervaller) = `DEGRADED`; filen mangler/er ulesbar = `UNKNOWN` (aldri «frisk»). Ikke satt opp (off-site, heartbeat) vises som en **merknad**, ikke skjult. Filen er ubetrodd data: fritekst fra verktøyutdata når aldri selvdiagnosen (kun feilkoder oversatt i API-et).

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
  * **Samme klynge-bevis (andre gjennomgang, L1).** Backupen lagrer kildeklyngens `system_identifier` (`pg_control_system()`) i manifestet (`source.system_identifier`), og verifiseringen nekter en scratch-server med SAMME identifikator - uavhengig av alias, DNS eller hva som ligger i den (`verify_config_invalid`, «samme system_identifier»); kan identifikatoren ikke leses når manifestet har en, er svaret nei. Eldre sett uten feltet krever ingenting (loggen sier «ingen system_identifier i manifestet»: da er tom-sjekken alene). Tom-sjekken er andre lag og teller nå også views, matviews, fremmede tabeller og sekvenser i `postgres`-databasen; databasenavn leses som `quote_ident(datname)` og sammenlignes uten normalisering (en database som heter « postgres» er fremmed). **Roller sjekkes ikke** (bevisst): en varig scratch samler roller fra tidligere kjøringer, så rolle-tomhet kan ikke kreves. En fysisk kopi/standby av produksjon har samme `system_identifier` og nektes også.
* **Standard (anbefalt): engangs-container uten nettverk.** `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` tom → `nas-restore-verify.sh` starter en Postgres-container med `--network none` og kaster den etterpå. **Herdet (andre gjennomgang, L4):** `--memory 4g --memory-swap 4g --cpus 2 --pids-limit 512`, `--cap-drop ALL` + `CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID` (det den offisielle postgres-entrypointen trenger), `--security-opt no-new-privileges:true`, `--read-only` med tmpfs for datakatalogen (3g), `/run/postgresql` og `/tmp`. En restore som trenger mer enn 3 GB datakatalog feiler lukket («No space left on device») - øk tallene øverst i `nas-restore-verify.sh`. **`NOT VERIFIED` mot en ekte Docker-daemon i byggemiljøet** (argv er låst av en test, men oppstarten med disse flaggene er ikke prøvd). **Eieren sjekker det med én kommando:** `bash ops/backup/nas-restore-verify.sh --selftest` - starter containeren med nøyaktig disse flaggene uten backup-sett, venter på `select 1`, skriver ut grensene Docker faktisk satte (`docker inspect`) og fjerner den; feiler den, vis `docker logs` før noe flagg løsnes. Deretter `acceptance-ops.sh drill` på PC-en. Med en egen, varig scratch-server (`JARVIS_BACKUP_VERIFY_SCRATCH_HOST` satt) gjelder: **`pg_restore` kjører dumpens SQL som superuser på scratch-serveren** (en ondsinnet dump kan f.eks. kjøre `COPY … PROGRAM`). Custom-format-dumper skal derfor KUN restores til en instans du kan kaste - aldri en delt eller produksjonsnær server. Den kan **ikke** kombineres med `JARVIS_BACKUP_VERIFY_SOURCE=offsite` (konfig-feil `verify_config_invalid`): et sett fra fjernmålet har den svakeste tilliten.
* **`globals.sql` filtreres.** Rolle-filen dekrypteres til minnet og whitelist-filtreres før `psql` ser den: kun `SET`, `CREATE ROLE`, `ALTER ROLE … WITH/SET`, `GRANT rolle TO rolle`, `COMMENT ON ROLE` og `set_config('search_path')` slippes gjennom, enhver backslash (psql-metakommando som `\!`) nektes, og teksten gjenoppbygges fra de validerte delene. **Andre gjennomgang (M1/M2):** (1) nøkkelordene `CURRENT_USER`, `SESSION_USER`, `CURRENT_ROLE`, `ALL`, `PUBLIC` og `NONE` nektes i enhver rollenavn-posisjon (siterte navn er ordinære roller); (2) setninger som angår **rollen verifisereren selv logger inn som** (`CREATE ROLE`/`ALTER ROLE`/`COMMENT ON ROLE` for den; standard `postgres`, ellers `JARVIS_BACKUP_VERIFY_SCRATCH_USER`/`--scratch-user`) **hoppes over** og telles i rapporten (`login_role_statements_skipped`) - valgt framfor å nekte filen fordi hver ekte `pg_dumpall` inneholder `CREATE/ALTER ROLE postgres`, og å hoppe over er like lukket (`ALTER ROLE postgres WITH NOLOGIN` låste ellers ut verifisereren; sammenligningen er case-insensitiv og følger Postgres sin 63-byte-avkorting); (3) `ALTER ROLE … SET <parameter>` lagres klyngeglobalt og leses ved neste tilkobling (`session_preload_libraries` = kodelasting), så kun en kort allowlist slippes gjennom (`ROLE_SET_ALLOWLIST` i `globals-filter.mjs`: search_path, statement_timeout, lock_timeout, idle_*_timeout, application_name, log_statement, timezone, datestyle, intervalstyle, client_encoding, default_transaction_read_only, work_mem, maintenance_work_mem) - alt annet, også punktum-parametere, nekter filen (`verify_integrity`, trinn `globals`); trenger en ekte kilde en til, vurder den og legg den til i listen; (4) hver setning har et tak på 8 KiB og antall setninger et tak på 20 000 (fiendtlige 4 MiB-innganger avvises på millisekunder - tokeniseringen er lineær). Alt annet (`CREATE TABLESPACE`, `DROP`, `COPY` ...) stopper verifiseringen med `verify_integrity` (trinn `globals`). **Roller restores uten passord-hasher** - scratch arver ikke produksjonens passord. Filteret beskytter verifisererens VERT (metakommandoer), ikke scratch-serveren mot dumpen: se punktet over.
* Manifestet valideres mot en lukket form før noe kjører (tabell- og databasenavn limes inn i SQL); avvik gir `verify_integrity` (trinn `manifest`).
* **Kilde off-site velger ikke «siste navn».** Hvem som helst med skrivetilgang til målet kan legge inn et navn som sorterer sist. Derfor: navn som ikke er en ekte dato (`jarvis-backup-99999999T999999Z`) eller ligger mer enn 5 min frem i tid er aldri kandidater (advarselen `offsite_set_name_implausible`), og finnes et lokalt komplett sett, **må** fjernmålets nyeste sett være nøyaktig det - ellers feiler verifiseringen med årsaken (`verify_failed`: «det nyeste lokale settet … finnes ikke i off-site-målet» = kopien er etter, eller «off-site-målet har nyere sett» = annen vert, klokkeavvik eller et plantet navn) i stedet for å verifisere noe annet. PC-en med kun verify-rollen har ingen lokale sett og får det nyeste plausible fjerne settet.

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
| `D01`–`D04` | restore til scratch lik manifestet (tabeller + eksakte radtall) **utført av dette tikket** (D01 krever handlingen `verify`, `reported_by=local` og en suksess nyere enn drillens start - en gammel grønn statusfil godtas ikke, og D02-D04 feiler da også), målt RTO, målt RPO, fersk kvittering til NAS (D04) |

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
| `set_incomplete` i loggen | et sett har manifest, men filene stemmer ikke (`problems` oppgir hvilke). Det teller ikke som backup, og slettes ikke. Er det en gammel rest: flytt eller slett katalogen for hånd |
| `retention.last_skipped_reason` er `offsite_failing` / `verify_failing` / `time_gap_hold` / `pipeline_stale` | retensjonen er pauset med vilje (se §6.1): rett off-site-/verifiseringsfeilen, eller vent ut holdet (24 t etter et langt gap) - gamle sett slettes ikke før det er trygt |
| `status` gir exit `3` med `set_dated_in_future:<sett>` | et komplett sett er datert i fremtiden (NAS-klokken gikk feil ved backup-tidspunktet). Det teller aldri som «nyeste» (verken i tikket, `status` eller `offsite-check`) og røres ikke av retensjon. Sjekk NTP/klokken på NAS-en, og fjern settet for hånd når du har bekreftet at et riktig datert sett finnes |
| Exit `3` med `lock_held_too_long` | låsen har vært holdt langt utover tikk-budsjettet: se `holder_pid`/`holder_host` i loggen, sjekk om prosessen henger (`ps`, `dmesg` for I/O-feil på USB/NFS), avslutt den; er prosessen borte, slett `.backup-schedule.lock` i state-mappen |
| `tick_watchdog_fired` i loggen, `*_timeout` i statusen | et steg hang og ble avbrutt av vaktbikkja (`stage` oppgir hvilket). Off-site mot USB/NFS: er disken/monteringen frisk? Backup: `docker ps`/DB-helse |
| Exit `4`, `verify_config_invalid`, «ikke en tom, kastbar instans» | scratch-serveren har andre databaser enn `postgres`/`template*`/`restore_verify_*` (meldingen nevner noen av dem) - er `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` feilpekt? Bruk engangs-containeren (la variabelen stå tom) eller en egen, tom Postgres. **Aldri** «fiks» dette ved å tømme en server du ikke eier |
| Exit `4`, `verify_integrity`, «globals.sql nektes» / trinn `manifest` | rolle-filen eller manifestet har noe utenfor de kjente formene (`last_error` oppgir linjenummer og årsak, aldri innholdet). Er settet ekte (f.eks. egne tablespaces)? Undersøk settet FØR du endrer filteret; er det manipulert, regn off-site-målet som kompromittert |
| Exit `4`, `verify_failed`, «off-site-målet har nyere sett …» eller «det nyeste lokale settet … finnes ikke i off-site-målet» | kilde off-site verifiserer bare settet som hører til det lokale nyeste (§6.6). «Finnes ikke»: off-site-kopien er etter (se `offsite.last_error_code`, rett den først). «Nyere sett»: noen annen har skrevet til målet, eller klokken var feil ved en backup - sjekk målet; er det planlagt/plantet, regn det som kompromittert |
| `offsite_set_name_implausible` i loggen | off-site-målet har sett med navn som ikke er en ekte dato eller ligger i fremtiden; de ignoreres. Sjekk hvem som har skrivetilgang til målet |
| `stale_tmp_removed` / `offsite_stale_incoming_removed` i loggen | foreldede rester etter et tikk som døde midt i en off-site-henting/-kopi er ryddet (§6.3). Dukker det opp ofte: undersøk hvorfor tikk avbrytes (strøm, OOM, `tick_watchdog_fired`) |
| `status_unusable` i `retention.last_skipped_reason` / `status_file_unusable` i loggen | statusfilen var borte/korrupt/tom/feil skjema/for stor (eller første kjøring): retensjonen er pauset til en verifisering eller off-site-bekreftelse er registrert (kun backup-rollen: etter et døgn). `schedule.mjs status` viser `status_file.problem`. Sjekk disk/rettigheter på state-mappen og hvorfor filen forsvant; ingenting gjøres for hånd |
| `orphan_set_has_data` i loggen (hvert tikk) | en settkatalog har innhold men ingen `manifest.json` (backup som døde midt i). Den slettes ALDRI automatisk (kan være det eneste som er igjen). Undersøk innholdet, og fjern katalogen for hånd når du er sikker |
| `orphan_check_unverified` i loggen | `lstat`/`readdir` mot en settkatalog ga EACCES/EIO/ESTALE (ustø disk/NFS/USB?): katalogen røres ikke. Sjekk monteringen (`dmesg`) |
| Exit `4`, «globals.sql nektes: … nøkkelord» / «… utenfor allowlisten» / «setningen er for lang» | rolle-filen har `CURRENT_USER`/`ALL`/`PUBLIC` som rollenavn, `ALTER ROLE … SET` av en parameter utenfor `ROLE_SET_ALLOWLIST`, eller en setning over 8 KiB. En ekte kilde som bruker en annen ufarlig parameter: vurder den og legg den til i listen. Er settet manipulert, regn off-site-målet som kompromittert |
| Exit `4`, «samme system_identifier» | `JARVIS_BACKUP_VERIFY_SCRATCH_HOST` peker på samme Postgres-klynge som kilden (eller en fysisk kopi av den). Bruk engangs-containeren eller en egen instans |
| Gjenværende scratch-containere | `docker ps -a --filter name=jarvis-restore-scratch` → `docker rm -f` (kun hvis et tikk ble drept hardt) |
| Statusen i selvdiagnosen er `UNKNOWN` | eksportmappen er ikke montert / filen mangler - kjør `acceptance-ops.sh nas` (O05/O06) |

## 6.9 Ærlige begrensninger og hvordan de verifiseres

* **`NOT VERIFIED` i dette miljøet** (ingen NAS, Docker-daemon, rclone, rsync/ssh eller ekstern leverandør): `docker compose exec`-banen mot den ekte stacken, `age-docker.sh` på NAS, rclone/rsync/ssh mot et ekte mål, ekte heartbeat-leverandør, systemd/cron/Oppgaveplanlegger, Windows Git Bash-banen (`bash`-argumentene bruker `C:/…`-skråstrek, uprøvd), UGOS-spesifikk atferd. **Verifiser** med `acceptance-ops.sh nas` (NAS) og `drill --from-offsite` (PC) over; `JARVIS_ACCEPTANCE_DRY_RUN=1` lister sjekkene uten å kjøre noe.
* **Testet her** (`npx vitest run ops/backup/test modules/core/test/wpc2-backup-schedule-e2e.test.ts apps/api/test/wpc2-backup-status.test.ts apps/api/test/wpc2-heartbeat-sender.test.ts modules/executive/test/wpc2-backup-limitation.test.ts`): forfalt-logikk, lås (ekte flerprosess-kappløp), retensjon, backoff, off-site-forhåndssjekk og lokal sink, argv for rclone/rsync (opptaker), heartbeat mot lokal server og `guardedFetch`, hele kjeden backup → off-site → restore-verify → heartbeat mot to ekte Postgres-klynger med ekte `pg_dump`/`age`, API-leseren og selvdiagnosen.
* **Restrisiko: rekursiv sletting er ikke `openat`-basert (andre gjennomgang, L3).** De to stedene Jarvis sletter rekursivt (`.incoming-*` i off-site-målet og `.verify-tmp-*`/utløpte sett i backup-mappen) bruker Node sin `fs.rm({ recursive })`, som slår opp stier på nytt per nivå. En angriper med skrivetilgang til mappen kunne i teorien bytte en katalog med en symlenke mellom sjekk og sletting (rimraf-race). Mønstrene er snevre (nøyaktig navnemønster, bare ekte kataloger via `lstat`, alder, under tikk-låsen), foreldreløse kataloger fjernes nå bare med `rmdir`, og backup-mappen/off-site-målet er 0700 og eid av tikk-brukeren - men det er IKKE bygget om. Mål: backup-mappen og off-site-målet skal ikke kunne skrives av andre enn tikk-brukeren.
* **Docker-herdingen av scratch-containeren og `--max-size` i rclone/rsync er `NOT VERIFIED`** (ingen daemon/ingen ekte rclone/rsync i byggemiljøet). `bash ops/backup/nas-restore-verify.sh --selftest` (§6.6) beviser containeren; `acceptance-ops.sh drill --from-offsite` beviser henting.
* **Off-site-retensjon** er `DEFERRED`/manuell (§6.3). **Kryptografisk attestasjon** av verifisererens kvittering finnes ikke (kvitteringen er en påstand fra din PC). **Full produksjons-restore** er ikke skriptet. **Verifisering uten Docker på NAS** støttes bare med en direkte scratch-server. **Uptime-monitoren** (eierens tjeneste) er utenfor Jarvis: alarmen er kun så god som varslingskanalen du kobler til den.
