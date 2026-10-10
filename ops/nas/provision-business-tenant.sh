#!/usr/bin/env bash
# Opprett en bedrifts-tenant (WP-D2, JARVIS-044/Q-48) - ÉN kommando på NAS-en, fra repoets rot:
#   ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" [slug]                               # dry-run: viser planen, skriver ingenting
#   ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" [slug] --confirm tenant-<slug>        # oppretter (idempotent - trygt å kjøre flere ganger)
# Du velger navnet (og eventuelt slug) selv - ingenting utledes fra konfig og ingenting opprettes automatisk. Uten slug utledes den fra navnet
# («Kundeoppfølging AS» -> tenant-kundeoppfolging-as); vil du ha tenant-kundeoppfolging, oppgi slug «kundeoppfolging».
# Hvorfor via `migrate`-tjenesten: kun den har admin-databasetilgangen CLI-en trenger (api/worker har den bevisst IKKE, Remediering del 2) - samme
# argument som ops/nas/enroll-device.sh. --confirm må være NØYAKTIG tenant-id-en dry-run viste.
# Etterpå: les utskriften «Dette må DU gjøre etterpå» (JARVIS_OWNER_EXTRA_TENANTS, enhet i tenanten, Q-48) - ingenting av det skjer automatisk.
# Valgfritt miljø: JARVIS_ENV_FILE, JARVIS_COMPOSE_FILE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
ENV_FILE="${JARVIS_ENV_FILE:-$ROOT/.env}"

usage() {
  echo 'bruk: ops/nas/provision-business-tenant.sh "Kundeoppfølging AS" [slug] [--confirm tenant-<slug>]' >&2
  exit 2
}

[ $# -ge 1 ] || usage
NAME="$1"
shift
SLUG=""
CONFIRM=""
if [ $# -ge 1 ] && [ "${1#--}" = "$1" ]; then
  SLUG="$1"
  shift
fi
if [ $# -ge 1 ]; then
  [ "$1" = "--confirm" ] && [ $# -eq 2 ] || usage
  CONFIRM="$2"
fi

# Enkel kontroll her; den ENDELIGE valideringen (norske tegn, lengde, tegnsett) gjør tjenesten selv og avviser alt ugyldig FØR noe skrives.
if [ "${#NAME}" -lt 2 ] || [ "${#NAME}" -gt 80 ] || printf '%s' "$NAME" | LC_ALL=C grep -q '[[:cntrl:]<>]'; then
  echo "ugyldig navn (2-80 tegn, ingen kontrolltegn, < eller >)" >&2
  exit 2
fi
if [ -n "$SLUG" ] && ! printf '%s' "$SLUG" | grep -Eq '^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])$'; then
  echo "ugyldig slug '$SLUG' (2-48 tegn: a-z, 0-9 og bindestrek, ikke bindestrek først/sist)" >&2
  exit 2
fi
if [ -n "$CONFIRM" ] && ! printf '%s' "$CONFIRM" | grep -Eq '^tenant-[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])$'; then
  echo "ugyldig --confirm '$CONFIRM' (må være tenant-id-en dry-run viste, f.eks. tenant-kundeoppfolging)" >&2
  exit 2
fi

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "finner ikke env-filen $ENV_FILE (compose trenger den)" >&2; exit 2; }

CLI_ARGS=(--name "$NAME")
[ -z "$SLUG" ] || CLI_ARGS+=(--slug "$SLUG")
[ -z "$CONFIRM" ] || CLI_ARGS+=(--confirm "$CONFIRM")

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  migrate node --experimental-transform-types apps/api/src/provision-business-tenant-main.ts "${CLI_ARGS[@]}"
