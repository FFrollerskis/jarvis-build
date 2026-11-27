#!/bin/bash
# WP-V2 (K4): en whisper-prosess som aldri avslutter - beviser at fristen (timeoutMs) DREPER prosessen i stedet for aa vente.
set -euo pipefail
cat >/dev/null
sleep 30
