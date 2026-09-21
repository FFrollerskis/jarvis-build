#!/bin/bash
# Task #125 (D-217): faket whisper.cpp-binær for LocalWhisperStt-tester.
# Verifiserer at -m/-f -/-nt/-l EKSAKT blir sendt (samme flaggform
# whisper.cpp selv dokumenterer for stdin-lesing), og at WAV-bytene faktisk
# ankommer på STDIN (§22-invarianten: end() skriver ALDRI en fil - se
# stt.ts sin klassekommentar) - printer deretter et transkript MED
# omkringliggende whitespace, for å bevise at end() faktisk trimmer stdout
# (samme disiplin som OpenAiStt sin egen retur).
set -euo pipefail
model=""
saw_dash_f=0
saw_nt=0
lang=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) model="$2"; shift 2 ;;
    -f) if [[ "$2" == "-" ]]; then saw_dash_f=1; fi; shift 2 ;;
    -nt) saw_nt=1; shift ;;
    -l) lang="$2"; shift 2 ;;
    *) shift ;;
  esac
done
bytecount=$(wc -c <&0)
if [[ -z "$model" || "$saw_dash_f" -ne 1 || "$saw_nt" -ne 1 || -z "$lang" || "$bytecount" -le 0 ]]; then
  echo "mock_whisper_missing_or_bad_args" >&2
  exit 1
fi
printf '  hei jarvis  \n'
