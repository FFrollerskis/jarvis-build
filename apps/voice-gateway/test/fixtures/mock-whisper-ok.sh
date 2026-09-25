#!/bin/bash
# Task #125 (D-217): faket whisper.cpp-binær for LocalWhisperStt-tester.
# Verifiserer at -m/-f -/-nt/-l EKSAKT blir sendt (samme flaggform
# whisper.cpp selv dokumenterer for stdin-lesing), og at WAV-bytene faktisk
# ankommer på STDIN (§22-invarianten: end() skriver ALDRI en fil - se
# stt.ts sin klassekommentar) - printer deretter et transkript MED
# omkringliggende whitespace, for å bevise at end() faktisk trimmer stdout
# (samme disiplin som OpenAiStt sin egen retur).
#
# D-266/D-267: verifiserer også at `-nth 1.01` (whisper.cpp sin egen
# no-speech-terskel, deaktivert siden VAD-en allerede eier tale/stillhet-
# vedtaket) faktisk sendes - `1.01` (IKKE `0.0`, D-267 sin rettelse av en
# bakvendt D-266-retning: `no_speech_prob > no_speech_thold` betyr en LAV
# terskel er MER aggressiv, ikke mindre) fordi en gyldig sannsynlighet
# aldri kan overstige 1.0 - se stt.ts sin kommentar rett over spawn()-kallet.
set -euo pipefail
model=""
saw_dash_f=0
saw_nt=0
saw_nth_disabled=0
lang=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) model="$2"; shift 2 ;;
    -f) if [[ "$2" == "-" ]]; then saw_dash_f=1; fi; shift 2 ;;
    -nt) saw_nt=1; shift ;;
    -nth) if [[ "$2" == "1.01" ]]; then saw_nth_disabled=1; fi; shift 2 ;;
    -l) lang="$2"; shift 2 ;;
    *) shift ;;
  esac
done
bytecount=$(wc -c <&0)
if [[ -z "$model" || "$saw_dash_f" -ne 1 || "$saw_nt" -ne 1 || "$saw_nth_disabled" -ne 1 || -z "$lang" || "$bytecount" -le 0 ]]; then
  echo "mock_whisper_missing_or_bad_args" >&2
  exit 1
fi
printf '  hei jarvis  \n'
