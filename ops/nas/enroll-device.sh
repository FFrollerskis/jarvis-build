#!/usr/bin/env bash
# Innrulleringsbillett for en NY nettleser/enhet (D-131, D-260, D-347) - ÉN kommando på NAS-en, fra repoets rot:
#   ops/nas/enroll-device.sh https://NAS-NAVN.TAILNETT.ts.net [dashboard|voice|chat]
# Adressen er den EKSTERNE HTTPS-adressen nettleseren faktisk bruker: enhetsnøkkelen lagres per nettleser OG adresse, og nettleseren krever HTTPS for å lage den (http:// går ikke).
# Utelates adressen, brukes JARVIS_PUBLIC_VOICE_BASE_URL fra miljøet, ellers fra env-filen (kun DEN ene, ikke-hemmelige linjen leses). Side: dashboard (standard), voice eller chat (forsiden).
# Hvorfor via `migrate`-tjenesten: kun den har admin-databasetilgangen CLI-en trenger for å lagre billetten (som SHA-256). api/worker har den bevisst IKKE (Remediering del 2),
# så hintet `pnpm --filter @jarvis/api enroll-ticket` på innrulleringssiden virker ikke i compose-oppsettet på NAS-en.
# Valgfri 3. parameter: tenant-id (WP-D2) - for å innrullere enheten i en bedrifts-tenant (ops/nas/enroll-device.sh <adresse> dashboard tenant-kundeoppfolging).
# Billetten skrives KUN til terminalen - aldri til fil, logg eller chat. Engangs, gyldig i 15 minutter. Valgfritt miljø: JARVIS_ENV_FILE, JARVIS_COMPOSE_FILE.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE_FILE="${JARVIS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
ENV_FILE="${JARVIS_ENV_FILE:-$ROOT/.env}"

BASE="${1:-${JARVIS_PUBLIC_VOICE_BASE_URL:-}}"
PAGE="${2:-dashboard}"
# WP-D2: valgfri 3. parameter = tenant-id (enheter er per tenant). Uten den gjelder JARVIS_TENANT_ID som før (kommandolinjen er da uendret).
TENANT="${3:-}"

# Kun den ene ikke-hemmelige adresselinjen hentes fra env-filen (aldri resten av innholdet).
if [ -z "$BASE" ] && [ -f "$ENV_FILE" ]; then
  BASE="$(grep -E '^JARVIS_PUBLIC_VOICE_BASE_URL=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d '\r' | sed -e "s/^[\"']//" -e "s/[\"']\$//" || true)"
fi
BASE="${BASE%/}"

if [ -z "$BASE" ]; then
  echo "mangler adresse: ops/nas/enroll-device.sh https://NAS-NAVN.TAILNETT.ts.net  (den adressen nettleseren bruker)" >&2
  exit 2
fi
case "$BASE" in
  https://*) ;;
  *) echo "adressen må begynne med https:// - nettleseren krever HTTPS for å lage enhetsnøkkelen (http:// går ikke)" >&2; exit 2;;
esac
if ! printf '%s' "$BASE" | grep -Eq '^https://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$'; then
  echo "ugyldig adresse '$BASE' (kun https://vert eller https://vert:port, uten sti eller mellomrom)" >&2
  exit 2
fi
case "$PAGE" in
  dashboard) PATH_ARG="dashboard";;
  voice) PATH_ARG="voice";;
  chat) PATH_ARG="/";;
  *) echo "ukjent side '$PAGE' (dashboard, voice eller chat)" >&2; exit 2;;
esac

if [ -n "$TENANT" ] && ! printf '%s' "$TENANT" | grep -Eq '^[a-z0-9][a-z0-9_-]{1,63}$'; then
  echo "ugyldig tenant-id '$TENANT' (a-z, 0-9, bindestrek og understrek, 2-64 tegn)" >&2
  exit 2
fi
TENANT_ARGS=()
[ -z "$TENANT" ] || TENANT_ARGS=(--tenant "$TENANT")

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på NAS-en" >&2; exit 2; }
[ -f "$COMPOSE_FILE" ] || { echo "finner ikke $COMPOSE_FILE" >&2; exit 2; }
[ -f "$ENV_FILE" ] || { echo "finner ikke env-filen $ENV_FILE (compose trenger den)" >&2; exit 2; }

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" run --rm --no-deps \
  -e "JARVIS_PUBLIC_VOICE_BASE_URL=$BASE" \
  migrate node --experimental-transform-types apps/api/src/enroll-ticket-main.ts --path "$PATH_ARG" ${TENANT_ARGS[@]+"${TENANT_ARGS[@]}"}

echo "Åpne lenken ovenfor i nettleseren du vil innrullere: marker den med musen (ikke dobbeltklikk) og lim den inn i adressefeltet. Lim aldri billetten eller lenken inn i chat." >&2
