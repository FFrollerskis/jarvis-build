#!/usr/bin/env bash
# EV-0 break-glass (D-410): NØDSTOPP for Jarvis som eieren kjører PÅ NAS-VERTEN, utenom Jarvis sine egne kanaler (API, Telegram, dashbord).
# Brukes når en av dem ikke kan stoles på. Jarvis kan ikke kjøre, endre eller lese dette - `ops/break-glass/` er en beskyttet sti (E3).
#
#   ops/break-glass/freeze-jarvis.sh                 # tørrkjøring: viser hva som VIL skje (endrer ingenting)
#   ops/break-glass/freeze-jarvis.sh --yes           # slå på kill switch i databasen OG stopp api/worker/voice-gateway
#   ops/break-glass/freeze-jarvis.sh --release --yes # opphev kill switch (fjerner raden), starter IKKE tjenestene
#   ops/break-glass/freeze-jarvis.sh --no-stop --yes # kun kill switch, la containerne gå
#
# Skriver ALDRI hemmeligheter (leser ingen nøkler; bruker kun DB-superbrukeren inne i postgres-containeren). Hver bruk skrives til audit_events
# (type break_glass.freeze / break_glass.release) slik at bruken kan etterprøves.
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${JARVIS_BREAKGLASS_ROOT:-$(cd "$HERE/../.." && pwd)}"
COMPOSE_FILE="${JARVIS_BREAKGLASS_COMPOSE_FILE:-$ROOT/infra/local/docker-compose.yml}"
ENV_FILE="${JARVIS_BREAKGLASS_ENV_FILE:-$ROOT/.env}"
DB_USER="${JARVIS_DB_ADMIN_USER:-postgres}"
DB_NAME="${JARVIS_DB_NAME:-jarvis}"
SERVICES="api worker voice-gateway"

YES=0; RELEASE=0; STOP=1
for arg in "$@"; do
  case "$arg" in
    --yes) YES=1 ;;
    --release) RELEASE=1 ;;
    --no-stop) STOP=0 ;;
    -h|--help) sed -n 2,12p "$0"; exit 0 ;;
    *) echo "ukjent argument: $arg (se --help)" >&2; exit 2 ;;
  esac
done

command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke i PATH - kjør dette på NAS-verten" >&2; exit 2; }

# Verdiene leses fra .env UTEN å source filen (ingen kjøring av innholdet) og skrives ikke ut.
envval() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
TENANT_ID="$(envval JARVIS_TENANT_ID)"
OWNER_ID="$(envval JARVIS_OWNER_PERSON_ID)"
if ! [[ "$TENANT_ID" =~ ^[A-Za-z0-9_.:-]+$ && "$OWNER_ID" =~ ^[A-Za-z0-9_.:-]+$ ]]; then
  echo "mangler/ugyldig JARVIS_TENANT_ID eller JARVIS_OWNER_PERSON_ID i $ENV_FILE - audit kan ikke skrives, avbryter" >&2
  exit 2
fi

psql_run() { docker compose -f "$COMPOSE_FILE" exec -T postgres psql -U "$DB_USER" -d "$DB_NAME" -X -v ON_ERROR_STOP=1 -c "$1"; }

if [ "$RELEASE" = 1 ]; then
  ACTION="release"
  SQL="DELETE FROM owner_control_state WHERE control_kind = 'kill_switch' AND control_target = 'GLOBAL';"
  AUDIT_TYPE="break_glass.release"
else
  ACTION="freeze"
  SQL="INSERT INTO owner_control_state (control_kind, control_target, reason, actor_person_id) VALUES ('kill_switch', 'GLOBAL', 'break-glass: eier-nødstopp fra NAS-verten', '$OWNER_ID') ON CONFLICT (control_kind, control_target) DO UPDATE SET reason = EXCLUDED.reason, actor_person_id = EXCLUDED.actor_person_id, changed_at = now();"
  AUDIT_TYPE="break_glass.freeze"
fi
AUDIT_SQL="INSERT INTO audit_events (tenant_id, person_id, type, decision, reason, tool_id, action, payload, actor_kind, process) VALUES ('$TENANT_ID', '$OWNER_ID', '$AUDIT_TYPE', 'ALLOW', 'owner_break_glass_from_host', 'break_glass', '$ACTION', '{\"stop_services\": $([ "$STOP" = 1 ] && [ "$RELEASE" = 0 ] && echo true || echo false)}'::jsonb, 'person', 'break-glass-script');"

echo "Break-glass: $ACTION"
echo "  compose: $COMPOSE_FILE"
echo "  1. SQL (kill switch):  $SQL"
echo "  2. SQL (revisjon):     skriver $AUDIT_TYPE til audit_events"
if [ "$RELEASE" = 0 ] && [ "$STOP" = 1 ]; then echo "  3. docker compose stop $SERVICES"; fi
if [ "$RELEASE" = 1 ]; then echo "  (opphevelse starter IKKE tjenestene - gjør det selv: docker compose up -d $SERVICES)"; fi

if [ "$YES" != 1 ]; then
  echo
  echo "TØRRKJØRING - ingenting er endret. Legg til --yes for å utføre."
  exit 0
fi

# Revisjon FØRST (strict): uten revisjonsspor skal nødstoppet likevel gjennomføres, men feilen meldes høyt.
if ! psql_run "$AUDIT_SQL" >/dev/null; then
  echo "ADVARSEL: revisjonsraden kunne ikke skrives - fortsetter med nødstoppet likevel" >&2
fi
psql_run "$SQL" || { echo "FEIL: kill switch kunne ikke endres i databasen" >&2; exit 1; }
if [ "$RELEASE" = 0 ] && [ "$STOP" = 1 ]; then
  docker compose -f "$COMPOSE_FILE" stop $SERVICES || { echo "FEIL: kunne ikke stoppe tjenestene" >&2; exit 1; }
fi
echo "Ferdig: $ACTION."
