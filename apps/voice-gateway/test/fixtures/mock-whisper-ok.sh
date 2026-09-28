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
#
# D-270: verifiserer også at `-otxt` (`--output-txt`) faktisk sendes - DEN
# FAKTISKE root cause for `text_length: 0` gjennom HELE D-262->D-269-runden.
# whisper-cli sin `fout_factory` (v1.9.4 cli.cpp) setter output-destinasjonen
# til INPUT-filnavnet (`-f -` -> "-") når `-of` ikke er gitt, som gjør
# `is_stdout` sann og DERMED deaktiverer selve segment-print-callback-en
# (`nullptr`) - `output_txt()` (funksjonen som faktisk skriver klartekst)
# kalles KUN når `-otxt` er satt. Uten dette flagget gjør whisper.cpp EKTE
# dekodingsarbeid og skriver resultatet INGEN STEDER - se stt.ts sin
# kommentar rett over spawn()-kallet for full kildekode-verifisert
# forklaring (D-41-disiplin).
#
# D-281: verifiserer også at `-of <base>` faktisk sendes, og SKRIVER
# transkriptet til `<base>.txt` (IKKE lenger stdout) - dette er den EKTE
# whisper.cpp sin egen skrivevei når `-of` er en reell fil-sti (`is_stdout`
# blir usann), og er DEN FAKTISKE fiksen for at `-otxt` uten `-of` skrev til
# en gjenåpnet, upålitelig "/dev/stdout" som Node.js sin pipe-baserte
# stdout ikke mottok bytes fra (se stt.ts sin kommentar over spawn()-kallet
# for full kildekode-verifisert forklaring).
set -euo pipefail
model=""
saw_dash_f=0
saw_nt=0
saw_nth_disabled=0
saw_otxt=0
outfile=""
lang=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m) model="$2"; shift 2 ;;
    -f) if [[ "$2" == "-" ]]; then saw_dash_f=1; fi; shift 2 ;;
    -nt) saw_nt=1; shift ;;
    -otxt) saw_otxt=1; shift ;;
    -of) outfile="$2"; shift 2 ;;
    -nth) if [[ "$2" == "1.01" ]]; then saw_nth_disabled=1; fi; shift 2 ;;
    -l) lang="$2"; shift 2 ;;
    *) shift ;;
  esac
done
bytecount=$(wc -c <&0)
if [[ -z "$model" || "$saw_dash_f" -ne 1 || "$saw_nt" -ne 1 || "$saw_otxt" -ne 1 || "$saw_nth_disabled" -ne 1 || -z "$outfile" || -z "$lang" || "$bytecount" -le 0 ]]; then
  echo "mock_whisper_missing_or_bad_args" >&2
  exit 1
fi
printf '  hei jarvis  \n' >"${outfile}.txt"
