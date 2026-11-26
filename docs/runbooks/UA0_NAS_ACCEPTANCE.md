# UA-0 NAS-akseptanse - slik kjører du den

**Formål (D-422):** samle EVIDENS fra den ekte NAS-en for UA-0-portene (D-27/D-28/D-35, UA0-AUTHORITY, OPS-RUNTIME, UA0-RUNRATE) i ett dokument,
uten hemmeligheter. Ingen port regnes lukket før du har kjørt dette på NAS-en og resultatet er lest.

## Kjør (én kommando, på NAS-en, fra repoets rot)
```
cd /volume1/jarvisbuild-data/jarvisbuild
git pull
JARVIS_BACKUP_DIR=<mappen nas-backup.sh skriver til> ops/acceptance/nas-ua0-gate.sh
```
Uten `JARVIS_BACKUP_DIR` blir backup-sjekkene (C10 og C13) `UNKNOWN`. Tørrkjøring (ingen docker): `JARVIS_ACCEPTANCE_DRY_RUN=1 ops/acceptance/nas-ua0-gate.sh`.
Skriptet leser aldri `.env` og skriver aldri passord; Postgres nås via lokal socket i containeren. C13 kaller backup-skriptet `ops/backup/nas-schedule.sh <mappe> status --json` (det leser sitt EGET oppsett, som backup-tikket gjør); gaten viser kun koder og tall fra svaret.
Evidensfilen havner i `ops/acceptance/out/` (git-ignorert).
Lim utskriften (eller filen) inn i chatten, så vurderer jeg den.

## Hva sjekkes
| Sjekk | Betyr |
|---|---|
| C01 | postgres, api og worker kjører |
| C02 | alle migrasjonsfiler i repoet er anvendt (rydder opp D-400 / 068) |
| C03 | pgvector installert + HNSW-indekser finnes (D-28) |
| C04 | `evolution_change_ledger`, `connector_maintenance_log`, `tasks.delivered_at` finnes |
| C05 | API `/health` = 200 (inkl. database) |
| C06 | lokal modellserver nåbar fra api-containeren, og `llama3.1:8b` + `bge-m3` finnes |
| C07 | hvor chat gikk siste 24 t - WARN hvis det kostet penger i sky (D-402) |
| C08 | feilede modellkall per leverandør siste 24 t |
| C09 | EV-0 oppstartssjekk (`ev0_constitution_boot`/`ev0_change_ledger_boot`) i api-loggen; usignert konstitusjon gir WARN |
| C10 | backup er ≤ 25 t gammel, og ukryptert `stray/` er borte (D-370) |
| C11 | tabellene uten RLS er NØYAKTIG de 9 dokumenterte globale (ellers FAIL) |
| C12 | api/worker kjører ikke som root, read-only rotfs, `cap_drop: ALL` |
| C13 | backup-status fra backup-skriptets eget statusskript (`nas-schedule.sh <mappe> status --json`, WP-OPS2a): exit 0 = `PASS`, 3 (backupen er forfalt) = `FAIL`, 4 (restore-verifisering feilet/for gammel) og 5 (off-site feilet/for gammel) = `WARN`, alt annet (konfig, kommando mangler, ugyldig JSON, tidsavbrudd, uenighet mellom exit-kode og JSON) = `UNKNOWN`. Uten `JARVIS_BACKUP_DIR` eller `node` på verten: `UNKNOWN`. Detaljen er kun koder og tall |
| C14 | vakthunden tikker (WP-OPS2a): alder på siste rad i `incident_producer_runs` for `watchdog`. Opptil 300 s = `PASS`, opptil 900 s = `WARN`, over 900 s = `FAIL`. Ingen rad = `UNKNOWN` («incident-produsentene er AV, eller worker har aldri tikket»): raden skrives kun med `JARVIS_INCIDENT_PRODUCERS_ENABLED=true` |

## C13 og C14: hva de krever og hva de ikke beviser
- **C13** beviser at backup-skriptet SELV melder frisk/forfalt akkurat nå. Det er ikke en restore-test og ikke bevis for at kopiene virker (det er restore-verifiseringen som svarer på det, og den vises som `verify=` i detaljen). `verify=never_run` uten at noe feiler gir `exit=0` og `PASS`: kjør `nas-restore-verify.sh` (runbooken for backup, §6) og se `verify=ok`.
- **C14** krever at incident-produsentene er på. Er de AV (standard), er C14 `UNKNOWN` - ikke et funn om at vakthunden er død. Slå dem på bevisst (`JARVIS_INCIDENT_PRODUCERS_ENABLED=true`, se `docs/runbooks/WPOPS2A_WATCHDOG.md`), eller bruk den eksterne heartbeaten for vakthunden (`JARVIS_WATCHDOG_HEARTBEAT_URL`) som ikke avhenger av dem.
- Begge er `NOT VERIFIED` til du har kjørt gaten på NAS-en og lest utskriften.

## Tolkning
- `PASS` = målingen var som forventet akkurat nå. Det er **ikke** det samme som at en UA-port er lukket.
- `WARN`/`UNKNOWN` er IKKE bestått - de må forklares eller fikses.
- `FAIL` gir exit-kode 1.

## Ikke dekket (må gjøres av deg eller i egne slicer)
Langfuse-trace mot `cost_events`, Infisical machine identity (rotér/tilbakekall), klasse D-pilot med Telegram-varsling, restore-drill og off-site-kopi (OPS-RUNTIME),
signert klasse D-godkjenning fra ekte enhet. Disse krever menneskelig handling eller egne scripts.
