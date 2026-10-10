#!/usr/bin/env bash
# WP-C1: bygger jobb-imaget lokalt og skriver ut image-ID-en som skal inn i /etc/jarvis/job-runner.json (runner.image).
#   infra/job-runner/build-job-image.sh [tag]            # standard tag: jarvis-job:YYYYMMDD
#
# Kjøres på verten av en bruker med docker-tilgang. Imaget bygges LOKALT (ingen push), og runneren bruker `--pull never`, så det som kjøres
# er nøyaktig det som ble bygget her. Image-ID-en (`sha256:<64 hex>`) er innholdsadressert og uforanderlig = «digest-pinnet». (Har du i
# stedet pushet imaget til et register, kan du bruke `navn@sha256:<digest>` fra `docker image inspect --format '{{index .RepoDigests 0}}'`.)
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAG="${1:-jarvis-job:$(date -u +%Y%m%d)}"
case "$TAG" in
  *[!A-Za-z0-9._:/-]*|"") echo "ugyldig tag: $TAG" >&2; exit 2 ;;
esac
command -v docker >/dev/null 2>&1 || { echo "docker finnes ikke - kjør dette på verten" >&2; exit 2; }

echo "== bygger $TAG (base-imaget hentes ved digest; npm ci fra lockfil)"
docker build --file "$HERE/Dockerfile.job" --tag "$TAG" "$HERE/claude-code"

ID="$(docker image inspect --format '{{.Id}}' "$TAG")"
case "$ID" in
  sha256:[0-9a-f][0-9a-f]*) : ;;
  *) echo "uventet image-ID: $ID" >&2; exit 1 ;;
esac
if [ "${#ID}" -ne 71 ]; then echo "uventet lengde på image-ID (${#ID}): $ID" >&2; exit 1; fi

echo "== selvtest (samme begrensninger som runneren: read-only, cap-drop ALL, ingen nettverk, ikke-root)"
docker run --rm --pull never --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 10001:10001 --tmpfs /tmp:rw,noexec,nosuid,nodev,size=64m --tmpfs /home/job:rw,noexec,nosuid,nodev,size=64m,uid=10001,gid=10001 \
  "$ID" sh -c 'test "$(id -u)" = 10001 && git --version && node --version && claude --version && test -d /work'

cat <<MSG

BYGGET OK.
  tag:        $TAG
  image-ID:   $ID

Neste steg (eier):
  1. Sett  "image": "$ID"  i /etc/jarvis/job-runner.json (runner-seksjonen).
  2. sudo systemctl restart jarvis-job-runner
  3. Kjør ops/job-runner/acceptance.sh (se docs/runbooks/JOB_RUNNER.md).
MSG
