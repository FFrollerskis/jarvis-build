# Evidens hf-1-ops-runtime-nas – 2026-10-12

Generert av `ops/acceptance/record-evidence.mjs` (WP-J, D-450) fra **pipet/innlimt utdata (`--stdin`)**: opptakeren har ikke kjørt noe og kan ikke bevise hvor teksten kom fra. Svakere enn en kjørt kommando - vurder den deretter. Vurderingen nederst er menneskelig.

- **Tidspunkt (UTC):** 2026-10-12T09:34:18.028Z
- **Vert:** vm
- **Git:** `b090d241e642aa1895301bb4ace307cdf0f03c0b` på `claude/evidens-2026-10-12-blokk2-backup`
- **Kommando:** (lest fra stdin)
- **Exit:** ukjent (utdata ble pipet inn via --stdin – opptakeren har IKKE kjørt kommandoen og kjenner ikke exit-koden)
- **Redigert:** ingen treff
- **Merknad:** Blokk 2: cron-tikk, statuseksport og OPS-RUNTIME-akseptanse (nas) limt inn av eier fra PuTTY på NAS 2026-10-12 kl. 08:57-09:26 UTC

## Utdata

````text
### 1. Cron-tikk observert (NAS, eier limte inn 2026-10-12)

$ date -u; grep last_tick_at /volume1/jarvisbuild-data/backups/encrypted/backup-status.json; tail -n 5 /volume1/jarvisbuild-data/backups/backup.log
Mon Oct 12 08:57:22 AM UTC 2026
  "last_tick_at": "2026-10-12T08:46:53.766Z",
[kommentar: dette er tikket eier tok for hånd kl. 08:46; cron-linjen var lagt inn like før, første hele kvarter var ennå ikke nådd]

(samme kommando igjen, etter hele kvarteret)
Mon Oct 12 09:00:02 AM UTC 2026
  "last_tick_at": "2026-10-12T09:00:01.376Z",
[kommentar: første tikk startet av cron. backup.log fikk ingen nye linjer (et tikk uten forfall er stille); de siste linjene var fra den gamle nattjobben]

### 2. Installasjon av cron-linjen (som vanlig bruker feilet, med sudo virket det)

$ (crontab -l | grep -v 'nas-schedule.sh'; echo '<ny linje>') | crontab -
/var/spool/cron/: mkstemp: Permission denied
[kommentar: ingenting ble endret; crontab -l viste fortsatt kun den gamle nattlinjen]

$ (crontab -l | grep -v 'nas-schedule.sh'; echo '<ny linje>') > ~/crontab-ny.txt && sudo crontab -u Jarvis ~/crontab-ny.txt && crontab -l
17 2 * * * cd /volume1/jarvisbuild-data/jarvisbuild && PATH=/usr/local/bin:/usr/bin:/bin ops/backup/nas-backup.sh /volume1/jarvisbuild-data/backups/encrypted >> /volume1/jarvisbuild-data/backups/backup.log 2>&1
*/15 * * * * cd /volume1/jarvisbuild-data/jarvisbuild && PATH=/usr/local/bin:/usr/bin:/bin ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted >> /volume1/jarvisbuild-data/backups/backup.log 2>&1

### 3. Statuseksport + compose-overstyring

$ mkdir -p /volume1/jarvisbuild-data/backups/status
$ echo 'JARVIS_BACKUP_STATUS_EXPORT_DIR=/volume1/jarvisbuild-data/backups/status' >> .env
$ ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted tick --json > /dev/null; echo "tikk-exit: $?"
tikk-exit: 0
$ sudo docker compose --env-file .env -f infra/local/docker-compose.yml -f infra/backup/docker-compose.backup-status.yml up -d api
[+] up 3/3
 ✔ Container local-postgres-1 Healthy                                                                           11.1s
 ✔ Container local-api-1      Started                                                                           12.2s
 ✔ Container local-migrate-1  Exited                                                                             0.8s

### 4. ops/backup/acceptance-ops.sh nas (tvunget backup via samme kodevei som cron, så fjerning av den gamle nattlinjen)

$ ops/backup/acceptance-ops.sh nas /volume1/jarvisbuild-data/backups/encrypted </dev/null; rc=$?; echo "akseptanse-exit: $rc"
O01_scheduled_backup       PASS            tvunget planlagt tikk tok backup (sett: jarvis-backup-20261012T092359Z, handlinger: backup,offsite)
O02_set_encrypted          PASS            jarvis-backup-20261012T092359Z: alle .age-filer har age-header, ingen klartekst, alder 0.01 t
O03_offsite_copy           PASS            rclone: nyeste sett finnes og stemmer (verifisering: sha256, 5 filer, 3816291 byte)
O04_heartbeat_received     NOT_CONFIGURED  JARVIS_BACKUP_HEARTBEAT_URL er ikke satt - ingen dead-man's switch (runbook §6.4)
O05_status_export          PASS            eksport finnes, modus 0644, 0 min gammel
O06_api_sees_status        PASS            api-containeren kan lese JARVIS_BACKUP_STATUS_FILE
O07_api_uptime_heartbeat   NOT_CONFIGURED  JARVIS_UPTIME_HEARTBEAT_URL er ikke satt (eller api er ikke startet på nytt etter at den ble satt)
O08_rpo                    UNKNOWN         INFO: verste tilfelle ≈ 24.25 t (intervall 24 t + 15 min tikk); eierens RPO-mål er ikke satt (JARVIS_RPO_TARGET_HOURS) - fyll inn i runbook §6.7

Sammendrag: PASS=5 FAIL=0 IKKE-SATT-OPP/UKJENT=3
Evidens skrevet til: /volume1/jarvisbuild-data/jarvisbuild/ops/acceptance/out/ops-acceptance-nas-20261012T092358Z.md
Ufullstendig: noe er ikke satt opp eller ikke målt (se NOT_CONFIGURED/UNKNOWN). OPS-RUNTIME er IKKE lukket.
akseptanse-exit: 3

(deretter, siden ingen FAIL: gammel nattlinje fjernet med sudo crontab -u Jarvis; crontab -l viste kun:)
*/15 * * * * cd /volume1/jarvisbuild-data/jarvisbuild && PATH=/usr/local/bin:/usr/bin:/bin ops/backup/nas-schedule.sh /volume1/jarvisbuild-data/backups/encrypted >> /volume1/jarvisbuild-data/backups/backup.log 2>&1
````

## Vurdering

- **Resultat:** **WARN (delvis bestått; OPS-RUNTIME er IKKE lukket).** Av åtte akseptansesjekker ble fem **PASS** (O01 planlagt backup, O02 kryptering, O03 off-site-kopi, O05 statuseksport, O06 api ser statusen), to er **NOT_CONFIGURED** (O04 backup-heartbeat, O07 API-oppetids-heartbeat) og én **UNKNOWN** (O08 RPO: eierens mål er ikke satt). Cron-tikket kjører. Ingen matriserad blir `VERIFIED` av denne filen.
- **Proveniens (les først):** alt er **håndlimt av eieren** fra PuTTY på NAS-en 2026-10-12 kl. 08:57-09:26 UTC. Feltene «Vert», «Git» og «Tidspunkt» øverst beskriver Claude-sandboxen som skrev filen, **ikke NAS-en**, og opptakeren kjørte ingenting: svakere evidens enn en kjørt kommando. Akseptansescriptet skrev selv en evidensfil på NAS-en (`ops/acceptance/out/ops-acceptance-nas-20261012T092358Z.md`, git-ignorert og ikke sjekket inn); det som er lest er skjermutskriften over. Git-SHA for arbeidskopien på NAS-en ble ikke logget (ikke dekket).
- **Gjelder matriserad(er):** OPS-RUNTIME, «10 Operations», EV-1 (backup-området i selvdiagnosen: eksport og montering OK, men chat-svaret er **ikke** observert ennå) og «Fysiske kjøringer» (off-site backup). Ingen rad flyttes til `VERIFIED`.

**Hva som ble observert, og hva det beviser**
- **Cron:** linjen `*/15 * * * *` → `nas-schedule.sh` står i brukeren Jarvis' crontab. `last_tick_at` gikk fra 08:46:53Z (tikket eier tok for hånd) til 09:00:01Z (første hele kvarter, startet av cron). Tikket var stille (ingenting forfalt), og `backup.log` fikk ingen nye linjer, altså ingen feil. Det beviser at cron starter tikket med et fungerende miljø for node, docker, `.env` og mottaker. Det beviser **ikke** at et cron-tikk selv tar en backup (første naturlige backup fra cron er ventet ca. 2026-10-13 09:23 UTC, 24 t etter det tvungne settet), og rclone fra cron er ikke utøvd ennå (off-site var ikke forfalt).
- **Backup via planleggerens kodevei (O01, O02):** et tvunget tikk (`--force-backup --roles backup,offsite`, samme kodevei som cron) tok settet `jarvis-backup-20261012T092359Z`. Alle `.age`-filer har age-header; ingen klartekst og ingen ukjente filer i settet.
- **Off-site (O03):** rclone → Google Drive (`gdrive:jarvis-backup`, scope `drive.file`): nyeste sett finnes i fjernmålet og stemmer mot manifestet med sha256 (5 filer, 3 816 291 byte). Tidligere i økten (limt inn, ikke gjengitt over) viste `offsite-check` `ok: true` og `newest_in_remote: true` med seks sett i Drive (20261008T135345Z-20261012T001701Z).
- **Statuseksport og montering (O05, O06):** `backup-status.json` skrives til en egen mappe (modus 0644, 0 min gammel), og api-containeren kan lese `JARVIS_BACKUP_STATUS_FILE`. Selvdiagnosen i chat («hva er galt med deg») er **ikke** observert med Backup-området ennå.
- **Gammel nattjobb** (`17 2 * * *` → `nas-backup.sh`) er fjernet etter at akseptansen ga ingen FAIL. Settet `…T001701Z` (00:17 UTC, samsvarer med 02:17 lokal tid) tyder på at nattjobben kjørte og at docker virker for brukeren Jarvis fra cron uten sudo, men det er ikke bekreftet fra `backup.log`.

**Funn**
1. `crontab` som vanlig bruker feilet på NAS-en: `/var/spool/cron/: mkstemp: Permission denied` (ingenting ble endret; `crontab -l` viste den gamle linjen). Det som virket: skriv ønsket crontab til en fil og installer den med `sudo crontab -u Jarvis <fil>`. Hvordan den gamle linjen ble lagt inn er ikke loggført, og hvorfor skriving som vanlig bruker nå feiler er ikke undersøkt. → rettet i runbook §6.2 og `infra/backup/crontab.example`.
2. Når statuseksporten er slått på, må **alle** senere `up` av api ha begge compose-filene (`-f infra/local/docker-compose.yml -f infra/backup/docker-compose.backup-status.yml`), ellers fjernes monteringen når api opprettes på nytt og «Backup» blir `UNKNOWN`. → `NAS_UPDATE_HF1_HF2.md` og runbook §6.5 rettet.
3. `sudo` midt i en innlimt flerlinjers blokk kan svelge neste linje; la `sudo` stå sist. Akseptansescriptet ble kjørt med `</dev/null` som forholdsregel (en `docker compose exec` kan ellers lese terminalen).
4. rclone ble installert fra offisiell `.deb` (pakket ut med `dpkg-deb -x`, kopiert til `/usr/local/bin`) fordi `apt` er i brutt tilstand på NAS-en (ctdb/time-avhengigheter). `apt --fix-broken install` er ikke kjørt (kan fjerne NAS-pakker). Vedlikeholdsgjeld: rclone oppdateres ikke automatisk.
5. Holdbarhet og sikkerhet (→ Q-61): Google-klienten står i «External/Testing», og da utløper refresh-token etter 7 dager med mindre appen publiseres eller kontoen er Workspace Internal; klient-hemmelighet og token ble limt inn i chatten og må roteres; privatnøkkelen (`jarvis-backup-identity`) ligger i samme Google Drive som de krypterte settene og må flyttes til to uavhengige frakoblede steder. At nøkkelen passer til mottakeren på NAS-en (`age19jpde…`) er ikke sjekket.

**Ikke dekket / gjenstår:** O04 og O07 (ekstern heartbeat), O08 (RPO-mål, Q-62), restore-drill fra off-site med privatnøkkel (D01-D04: RTO/RPO er ikke målt), første naturlige backup fra cron, retensjon i Google Drive (manuell), selvdiagnosens Backup-område i chat, og at en feilet backup/off-site faktisk gir varsel.
