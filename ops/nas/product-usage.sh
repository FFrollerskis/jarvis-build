#!/usr/bin/env bash
# Produktbruk og churn (WP-D2, UA-3 «churn/product usage») på NAS-en - ÉN kommando fra repoets rot:
#   ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging --format csv --label 2026-10 < bruk.csv               # dry-run: validerer, skriver ingenting
#   ops/nas/product-usage.sh import --tenant tenant-kundeoppfolging --format csv --label 2026-10 --confirm < bruk.csv     # lagrer (idempotent per hendelses-id)
#   ops/nas/product-usage.sh accounts --tenant tenant-kundeoppfolging [--unlinked|--linked]                                # kontoer + hvilke selskap de er koblet til
#   ops/nas/product-usage.sh link --tenant tenant-kundeoppfolging --account <konto-ref> --company <company_id> --confirm  # koble konto -> kundeselskap
#   ops/nas/product-usage.sh unlink --tenant tenant-kundeoppfolging --account <konto-ref> --confirm
#   ops/nas/product-usage.sh forget-user --tenant tenant-kundeoppfolging --user <bruker-ref> --confirm                     # «glem bruker» (nuller user_ref, beholder volum)
# Filen (CSV med header eller JSONL) sendes på STDIN - ingen filstier, ingen volummontering. Kolonner/felt: event_id, account_ref, feature, occurred_at, quantity
# (+ valgfritt user_ref og kind=billing_status). Alt annet (e-post, navn, ip ...) avvises. Alt som skriver er en dry-run uten --confirm.
# Hvorfor via `migrate`-tjenesten: den er den minste containeren som har runtime-rollens påloggingsopplysninger; CLI-en kjører SOM runtime-rollen (RLS gjelder) og
# stopper hvis rollen omgår RLS. Admin-passordet brukes ikke.
# Valgfritt miljø: JARVIS_ENV_FILE, JARVIS_COMPOSE_FILE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
ENV_FILE="${JARVIS_ENV_FILE:-$ROOT/.env}"

usage() {
  echo 'bruk: ops/nas/product-usage.sh <import|accounts|link|unlink|forget-user> --tenant <tenant-id> [--format csv|jsonl --label <etikett>] [--account <ref>] [--company <id>] [--user <ref>] [--confirm]' >&2
  exit 2
}

[ $# -ge 1 ] || usage
CMD="$1"
shift
case "$CMD" in
  import|accounts|link|unlink|forget-user) ;;
  *) echo "ukjent kommando '$CMD'" >&2; usage ;;
esac

# Enkel validering her (ingenting tolkes av skallet - hvert argument sendes videre som ÉN streng); den ENDELIGE valideringen gjør CLI-en og tjenesten.
ARGS=()
SEEN=" "
while [ $# -gt 0 ]; do
  case "$1" in
    --confirm|--linked|--unlinked)
      case "$SEEN" in *" $1 "*) echo "$1 er oppgitt flere ganger" >&2; exit 2 ;; esac
      SEEN="$SEEN$1 "
      ARGS+=("$1")
      shift
      ;;
    --tenant|--format|--label|--account|--company|--user)
      FLAG="$1"
      [ $# -ge 2 ] || { echo "$FLAG mangler verdi" >&2; exit 2; }
      case "$SEEN" in *" $FLAG "*) echo "$FLAG er oppgitt flere ganger" >&2; exit 2 ;; esac
      SEEN="$SEEN$FLAG "
      VAL="$2"
      case "$FLAG" in
        --tenant) PATTERN='^[a-z0-9][a-z0-9_-]{1,63}$' ;;
        --format) PATTERN='^(csv|jsonl)$' ;;
        --label) PATTERN='^[a-z0-9][a-z0-9_.-]{0,39}$' ;;
        --account|--user) PATTERN='^[A-Za-z0-9][A-Za-z0-9_.:-]{5,127}$' ;;
        --company) PATTERN='^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' ;;
      esac
      printf '%s' "$VAL" | grep -Eq "$PATTERN" || { echo "ugyldig verdi for $FLAG" >&2; exit 2; }
      ARGS+=("$FLAG" "$VAL")
      shift 2
      ;;
    *)
      echo "ukjent argument '$1'" >&2
      exit 2
      ;;
  esac
done

case "$SEEN" in *" --tenant "*) ;; *) echo "--tenant er påkrevd" >&2; exit 2 ;; esac
if [ "$CMD" = "import" ]; then
  case "$SEEN" in *" --format "*) ;; *) echo "import krever --format" >&2; exit 2 ;; esac
  case "$SEEN" in *" --label "*) ;; *) echo "import krever --label" >&2; exit 2 ;; esac
fi

if [ "$CMD" = "import" ] && [ -t 0 ]; then
  echo "import leser filen fra stdin - bruk:  ... --confirm < bruk.csv" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "finner ikke env-filen $ENV_FILE (compose trenger den)" >&2; exit 2; }

# -T: ingen pseudo-TTY, slik at stdin (filen) kommer gjennom til containeren.
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps -T \
  migrate node --experimental-transform-types apps/api/src/product-usage-main.ts "$CMD" ${ARGS[@]+"${ARGS[@]}"}
