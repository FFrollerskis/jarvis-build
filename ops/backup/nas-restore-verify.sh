#!/usr/bin/env bash
# Restore-verifisering på NAS-en mot en ENGANGS Postgres-container (aldri produksjonsdatabasen).
#   ops/backup/nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil>
#   ops/backup/nas-restore-verify.sh --selftest        (kun containeren: starter den herdede scratch-containeren, venter på `select 1`, viser grensene og fjerner den)
# Starter en container fra samme pinnede image som compose, restorer ALLE databaser fra settet
# dit, sammenligner tabellinventar + eksakte radtall mot manifestet, og fjerner containeren.
# Skriver kun navn og tall - aldri radinnhold. Exit 0 = verifisert, 2 = avvik, annet = feil.
set -euo pipefail

SELFTEST=0
if [ "${1:-}" = "--selftest" ]; then
  SELFTEST=1
  SET_DIR=""
  IDENTITY=""
else
  SET_DIR="${1:?bruk: nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil> | --selftest}"
  IDENTITY="${2:?bruk: nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil> | --selftest}"
fi
# MÅ holdes lik pgvector-imaget i infra/local/docker-compose.yml (sjekkes av en test).
IMAGE="pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"
NAME="jarvis-restore-scratch-$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$SELFTEST" = 0 ]; then
  [ -d "$SET_DIR" ] || { echo "finner ikke backup-sett: $SET_DIR" >&2; exit 1; }
  [ -f "$IDENTITY" ] || { echo "finner ikke identitetsfil: $IDENTITY" >&2; exit 1; }
fi

# Tilfeldig engangspassord, sendt til Docker ved NAVN (ikke i argv).
POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export POSTGRES_PASSWORD
export JARVIS_SCRATCH_DB_PASSWORD="$POSTGRES_PASSWORD"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# HERDING av engangs-containeren. Settet er UBETRODD (age er ikke autentisert), og pg_restore kjører SQL fra dumpen som superuser her (f.eks. COPY ... PROGRAM) - containeren er
# sandkassen, så den får ingenting den ikke trenger:
#  - --network none (review F2): ingen vei ut; data kommer inn via `docker exec -i` (stdin) og unix-socketen inne i containeren.
#  - Ressursgrenser (review runde 2, L4): minne (og dermed tmpfs-dataene, som teller mot minnegrensen), ingen swap, CPU og antall prosesser - en dump som fyller minnet, forker i det
#    uendelige eller spinner stopper ved grensen i stedet for å ta NAS-en med seg. Datakatalogen (tmpfs) er 3g av de 4g; en større restore feiler lukket med «No space left on device».
#    Endre tallene her hvis databasene vokser (kun denne filen).
#  - --cap-drop ALL + akkurat de fem Linux-capabilityene den offisielle postgres-entrypointen trenger for å eie datakatalogen og bytte til brukeren postgres (CHOWN, DAC_OVERRIDE, FOWNER,
#    SETGID, SETUID - samme sett som er dokumentert i herdingsguider for imaget), --security-opt no-new-privileges (ingen setuid-eskalering).
#  - --read-only rotfilsystem: Postgres trenger kun skrivbar datakatalog (tmpfs), /run/postgresql (socket + pid) og /tmp (alle tmpfs, noexec/nosuid som Docker-standard).
# NOT VERIFIED mot en ekte Docker-daemon i byggemiljøet (ingen daemon der): kjør `ops/backup/nas-restore-verify.sh --selftest` (starter containeren med nøyaktig disse flaggene og viser
# grensene Docker faktisk satte) og deretter `ops/backup/acceptance-ops.sh drill ...` på maskinen med den private nøkkelen. Feiler oppstarten, se `docker logs` før noe flagg løsnes.
# MSYS_NO_PATHCONV: Git Bash på Windows omskriver ellers `/var/lib/...` til `C:/Program Files/Git/var/lib/...` i docker-argumenter (D-372); ufarlig andre steder.
MSYS_NO_PATHCONV=1 docker run -d --name "$NAME" \
  --network none \
  --memory 4g --memory-swap 4g --cpus 2 --pids-limit 512 \
  --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETGID --cap-add SETUID \
  --security-opt no-new-privileges:true \
  --read-only \
  --tmpfs /var/lib/postgresql/data:size=3g --tmpfs /run/postgresql:size=16m --tmpfs /tmp:size=256m \
  -e POSTGRES_PASSWORD \
  "$IMAGE" >/dev/null

# Imaget starter en midlertidig server under initdb og restarter - vent til den ER oppe to ganger på rad.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    sleep 3
    if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "scratch-containeren ble ikke klar (siste loggrader fra containeren under)" >&2; docker logs --tail 20 "$NAME" >&2 || true; exit 1; }

if [ "$SELFTEST" = 1 ]; then
  # Viser grensene Docker FAKTISK satte (ikke bare det vi ba om), så eieren kan se at herdingen er på og at Postgres likevel kom opp.
  docker inspect --format 'network={{.HostConfig.NetworkMode}} memory={{.HostConfig.Memory}} swap={{.HostConfig.MemorySwap}} pids={{.HostConfig.PidsLimit}} nanocpus={{.HostConfig.NanoCpus}} readonly={{.HostConfig.ReadonlyRootfs}} capdrop={{.HostConfig.CapDrop}} capadd={{.HostConfig.CapAdd}} secopt={{.HostConfig.SecurityOpt}}' "$NAME"
  echo "selftest OK: herdet scratch-container startet og svarer på select 1 (fjernes nå)"
  exit 0
fi

# Git Bash på Windows: node.exe forstår ikke /c/Users/... - bruk Windows-stil (C:/Users/...) når cygpath finnes (D-372).
NODE_HERE="$HERE"
if command -v cygpath >/dev/null 2>&1; then NODE_HERE="$(cygpath -m "$HERE")"; fi

# Aldri stol på exit-koden alene: en stille exit 0 uten rapport er IKKE et bevis (D-372).
rc=0
REPORT="$(node "$NODE_HERE/jarvis-backup.mjs" verify --set "$SET_DIR" --identity "$IDENTITY" --scratch-container "$NAME")" || rc=$?
printf '%s\n' "$REPORT"
if [ "$rc" -eq 0 ] && ! printf '%s' "$REPORT" | grep -q '"ok": true'; then
  echo "restore-verifisering ga ingen OK-rapport - IKKE verifisert" >&2
  exit 3
fi
exit "$rc"
