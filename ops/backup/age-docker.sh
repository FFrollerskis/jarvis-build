#!/usr/bin/env bash
# `age` i en engangs-container for verter uten age (D-370). Drop-in for backup-verktøyet:
#   JARVIS_AGE_BIN=ops/backup/age-docker.sh
# Støtter kryptering: `age -r <age1...> [-o FIL]` med klartekst på stdin. `-o FIL` oversettes til
# omdirigering av stdout slik at ingen volum monteres. Containeren har ingen nettverkstilgang,
# alle capabilities fjernet og read-only rootfs. Dekryptering (-d/-i) støttes IKKE her: restore
# bevises på en annen maskin enn NAS-en (BACKUP_RESTORE_RUNBOOK §5).
#   age-docker.sh --ensure-image   bygger image første gang (trenger nett én gang)
set -euo pipefail
IMAGE="${JARVIS_AGE_IMAGE:-jarvis-age:1}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "${1:-}" = "--ensure-image" ]; then
  docker image inspect "$IMAGE" >/dev/null 2>&1 || docker build -q -t "$IMAGE" -f "$HERE/age.Dockerfile" "$HERE" >/dev/null
  exit 0
fi

args=()
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="${2:?-o trenger filnavn}"; shift 2 ;;
    -d|--decrypt|-i|--identity) echo "age-docker.sh støtter kun kryptering" >&2; exit 2 ;;
    *) args+=("$1"); shift ;;
  esac
done

run=(docker run --rm -i --network none --cap-drop ALL --read-only --security-opt no-new-privileges "$IMAGE" "${args[@]}")
if [ -n "$out" ]; then
  umask 077
  "${run[@]}" > "$out"
else
  "${run[@]}"
fi
