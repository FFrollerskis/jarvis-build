#!/bin/bash
# Task #125 (D-217): faket piper-binær for LocalPiperTts-tester. Verifiserer
# --model/--output_raw EKSAKT blir sendt (samme flaggform piper selv
# dokumenterer), konsumerer stdin (teksten), skriver deretter TRE separate
# rå PCM-"rammer" til stdout MED en kort pause mellom hver - beviser at
# rammer leveres FORTLØPENDE (ekte strømming), ikke som én batch ved slutt.
set -euo pipefail
model=""
raw=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --output_raw) raw=1; shift ;;
    *) shift ;;
  esac
done
cat >/dev/null
if [[ -z "$model" || "$raw" -ne 1 ]]; then
  echo "mock_piper_missing_or_bad_args" >&2
  exit 1
fi
printf 'AAAA'
sleep 0.3
printf 'BBBB'
sleep 0.3
printf 'CCCC'
