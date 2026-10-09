#!/usr/bin/env bash
# Planlagt backup-tikk på NAS-en (WP-C2, OPS-RUNTIME). Kjør fra cron / systemd-timer hvert 15. minutt:
#   ops/backup/nas-schedule.sh <backup-mappe> [tick|status|offsite-check] [schedule.mjs-flagg ...]
# Standardkommando er `tick`: tar backup / off-site-kopi / restore-verifisering KUN når de er forfalt (ellers gjør det ingenting og er stille).
# Samme sikre innlesing som nas-backup.sh: DB-admin-passordet leses fra repoets .env (aldri argv) og den OFFENTLIGE age-nøkkelen fra
# ~/.jarvis-backup-recipient. Privatnøkkelen skal IKKE finnes på NAS-en. I tillegg leses JARVIS_BACKUP_* (intervall, off-site, heartbeat, statuseksport)
# fra .env - miljøet vinner over .env. Ingenting annet fra .env sendes videre, og ingen verdi skrives til skjerm.
# Exit-koder: se ops/backup/schedule.mjs (0 ok · 1 konfig · 2 backup feilet · 3 forfalt · 4 restore-verify · 5 off-site · 6 off-site ikke satt opp).
set -euo pipefail

OUT_DIR="${1:?bruk: nas-schedule.sh <backup-mappe> [tick|status|offsite-check] [flagg ...]}"
shift
CMD="${1:-tick}"
if [ $# -gt 0 ]; then shift; fi
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
RECIPIENT_FILE="${JARVIS_BACKUP_RECIPIENT_FILE:-$HOME/.jarvis-backup-recipient}"

[ -f "$ROOT/.env" ] || { echo "finner ikke $ROOT/.env" >&2; exit 1; }

# Siste forekomst av NAVN i .env, uten CR (Windows-linjeskift, D-371), uten omsluttende anførselstegn og uten etterfølgende « # kommentar» (compose-stil).
env_value() {
  local line value
  line="$(grep -E "^$1=" "$ROOT/.env" | tail -n1 || true)"
  value="${line#*=}"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
    *) value="${value%% \#*}"; value="${value%"${value##*[![:space:]]}"}" ;;
  esac
  printf '%s' "$value"
}

JARVIS_DB_ADMIN_PASSWORD="$(env_value JARVIS_DB_ADMIN_PASSWORD)"
JARVIS_DB_ADMIN_USER="$(env_value JARVIS_DB_ADMIN_USER)"
export JARVIS_DB_ADMIN_PASSWORD
if [ -n "${JARVIS_DB_ADMIN_USER:-}" ]; then export JARVIS_DB_ADMIN_USER; else unset JARVIS_DB_ADMIN_USER; fi

# JARVIS_BACKUP_* fra .env (kun navn som matcher mønsteret). Miljøet som allerede er satt vinner; tomme verdier = usatt.
while IFS= read -r name; do
  [[ "$name" =~ ^JARVIS_BACKUP_[A-Z0-9_]+$ ]] || continue
  if [ -n "${!name+x}" ]; then continue; fi
  value="$(env_value "$name")"
  [ -n "$value" ] || continue
  export "$name=$value"
done < <(grep -oE '^JARVIS_BACKUP_[A-Z0-9_]+=' "$ROOT/.env" | sed 's/=$//' | sort -u || true)

# Mottaker (offentlig nøkkel): fil først (som nas-backup.sh), ellers det som allerede står i miljøet/.env.
if [ -f "$RECIPIENT_FILE" ]; then
  JARVIS_BACKUP_AGE_RECIPIENT="$(head -n1 "$RECIPIENT_FILE" | tr -d '[:space:]')"
  export JARVIS_BACKUP_AGE_RECIPIENT
elif [ -z "${JARVIS_BACKUP_AGE_RECIPIENT:-}" ] && [ "$CMD" = "tick" ]; then
  echo "finner ikke $RECIPIENT_FILE (offentlig age-nøkkel, én linje) og JARVIS_BACKUP_AGE_RECIPIENT er ikke satt" >&2
  exit 1
fi

# NAS-er (UGOS/DSM) leveres uten `age`: lokalt bygd engangs-container i stedet (D-370). Kun den OFFENTLIGE nøkkelen sendes inn.
if ! command -v age >/dev/null 2>&1; then
  export JARVIS_AGE_BIN="$HERE/age-docker.sh"
  "$JARVIS_AGE_BIN" --ensure-image
fi

# docker compose finner .env og relative stier fra arbeidskatalogen (som i runbooken: «cd <jarvisbuild-mappen> && …»).
cd "$ROOT"
case "$CMD" in
  tick)
    mkdir -p "$OUT_DIR"
    chmod 700 "$OUT_DIR"
    exec node "$HERE/schedule.mjs" tick --mode docker --compose-file "$ROOT/infra/local/docker-compose.yml" --out "$OUT_DIR" "$@"
    ;;
  status|offsite-check)
    exec node "$HERE/schedule.mjs" "$CMD" --out "$OUT_DIR" "$@"
    ;;
  *)
    echo "ukjent kommando: $CMD (tick|status|offsite-check)" >&2
    exit 1
    ;;
esac
