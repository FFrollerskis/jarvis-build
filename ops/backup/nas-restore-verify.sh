#!/usr/bin/env bash
# Restore-verifisering på NAS-en mot en ENGANGS Postgres-container (aldri produksjonsdatabasen).
#   ops/backup/nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil>
# Starter en container fra samme pinnede image som compose, restorer ALLE databaser fra settet
# dit, sammenligner tabellinventar + eksakte radtall mot manifestet, og fjerner containeren.
# Skriver kun navn og tall - aldri radinnhold. Exit 0 = verifisert, 2 = avvik, annet = feil.
set -euo pipefail

SET_DIR="${1:?bruk: nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil>}"
IDENTITY="${2:?bruk: nas-restore-verify.sh <backup-sett-mappe> <age-identitetsfil>}"
# MÅ holdes lik pgvector-imaget i infra/local/docker-compose.yml (sjekkes av en test).
IMAGE="pgvector/pgvector:pg16@sha256:7b822b0aac60967beb1ea5e576b8602c94c300a157d187f385ae3e0da199b90a"
NAME="jarvis-restore-scratch-$$"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[ -d "$SET_DIR" ] || { echo "finner ikke backup-sett: $SET_DIR" >&2; exit 1; }
[ -f "$IDENTITY" ] || { echo "finner ikke identitetsfil: $IDENTITY" >&2; exit 1; }

# Tilfeldig engangspassord, sendt til Docker ved NAVN (ikke i argv).
POSTGRES_PASSWORD="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
export POSTGRES_PASSWORD
export JARVIS_SCRATCH_DB_PASSWORD="$POSTGRES_PASSWORD"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD --tmpfs /var/lib/postgresql/data "$IMAGE" >/dev/null

# Imaget starter en midlertidig server under initdb og restarter - vent til den ER oppe to ganger på rad.
ready=0
for _ in $(seq 1 60); do
  if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then
    sleep 3
    if docker exec "$NAME" psql -U postgres -tAc 'select 1' >/dev/null 2>&1; then ready=1; break; fi
  fi
  sleep 1
done
[ "$ready" = 1 ] || { echo "scratch-containeren ble ikke klar" >&2; exit 1; }

# Git Bash på Windows: node.exe forstår ikke /c/Users/... - bruk Windows-stil (C:/Users/...) når cygpath finnes (D-372).
NODE_HERE="$HERE"
if command -v cygpath >/dev/null 2>&1; then NODE_HERE="$(cygpath -m "$HERE")"; fi

node "$NODE_HERE/jarvis-backup.mjs" verify --set "$SET_DIR" --identity "$IDENTITY" --scratch-container "$NAME"
