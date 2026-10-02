#!/usr/bin/env bash
# Daglig kryptert backup av jarvis + infisical + langfuse på NAS-en (kjør fra cron).
#   ops/backup/nas-backup.sh <backup-mappe>
# Leser admin-passordet fra repoets .env (aldri argv) og den OFFENTLIGE age-nøkkelen fra
# ~/.jarvis-backup-recipient (én linje, age1...). Privatnøkkelen skal IKKE finnes på NAS-en.
# Exit 0 = backup tatt og ferskhet bekreftet; ellers ikke-null.
set -euo pipefail

OUT_DIR="${1:?bruk: nas-backup.sh <backup-mappe>}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RECIPIENT_FILE="${JARVIS_BACKUP_RECIPIENT_FILE:-$HOME/.jarvis-backup-recipient}"

[ -f "$ROOT/.env" ] || { echo "finner ikke $ROOT/.env" >&2; exit 1; }
[ -f "$RECIPIENT_FILE" ] || { echo "finner ikke $RECIPIENT_FILE (offentlig age-nøkkel, én linje)" >&2; exit 1; }

JARVIS_DB_ADMIN_PASSWORD="$(grep -E '^JARVIS_DB_ADMIN_PASSWORD=' "$ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '\r')"
JARVIS_DB_ADMIN_USER="$(grep -E '^JARVIS_DB_ADMIN_USER=' "$ROOT/.env" | tail -n1 | cut -d= -f2- | tr -d '\r' || true)"
JARVIS_BACKUP_AGE_RECIPIENT="$(head -n1 "$RECIPIENT_FILE" | tr -d '[:space:]')"
export JARVIS_DB_ADMIN_PASSWORD JARVIS_BACKUP_AGE_RECIPIENT
[ -n "${JARVIS_DB_ADMIN_USER:-}" ] && export JARVIS_DB_ADMIN_USER

# NAS-er (UGOS/DSM) leveres uten `age`: bruk en lokalt bygd engangs-container i stedet (D-370).
# Kun den OFFENTLIGE nøkkelen sendes inn; containeren har ingen nettverkstilgang.
if ! command -v age >/dev/null 2>&1; then
  export JARVIS_AGE_BIN="$HERE/age-docker.sh"
  "$JARVIS_AGE_BIN" --ensure-image
fi

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"

node "$HERE/jarvis-backup.mjs" backup --mode docker --compose-file "$ROOT/infra/local/docker-compose.yml" --out "$OUT_DIR" --retain-days "${JARVIS_BACKUP_RETAIN_DAYS:-30}"
node "$HERE/jarvis-backup.mjs" status --out "$OUT_DIR" --max-age-hours 25
