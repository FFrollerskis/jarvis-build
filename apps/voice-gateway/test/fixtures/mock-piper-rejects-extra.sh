#!/bin/bash
# D-405: faket piper som avviser alle flagg utenom --model/--output_raw (som en binær uten --length_scale e.l.).
set -euo pipefail
cat >/dev/null
model=""; raw=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) model="$2"; shift 2 ;;
    --output_raw) raw=1; shift ;;
    *) echo "mock_piper_unknown_arg:$1" >&2; exit 2 ;;
  esac
done
[[ -n "$model" && "$raw" -eq 1 ]] || exit 1
printf 'OKOK'
