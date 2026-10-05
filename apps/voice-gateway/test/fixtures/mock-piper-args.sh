#!/bin/bash
# D-405: faket piper som skriver sine EGNE argumenter (én per linje) som «lyd» - testen leser argv slik piper faktisk fikk det.
set -euo pipefail
cat >/dev/null
for a in "$@"; do printf '%s\n' "$a"; done
