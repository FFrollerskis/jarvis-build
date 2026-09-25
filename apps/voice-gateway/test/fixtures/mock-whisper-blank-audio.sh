#!/bin/bash
# D-263: faket whisper.cpp-binær som reproduserer det EKTE live-funnet på
# NAS-en - kode 0 (INGEN local_whisper_process_failed), men HELT TOMT
# stdout, mens whisper.cpp sin egen diagnostikk (modell-/"no speech"-info)
# fortsatt skrives til stderr. FØR D-263 ble denne stderr-en stille kastet
# bort på nøyaktig denne (suksess+tomt resultat) stien - se
# voice_stt_empty_result_diagnostic-kommentaren i stt.ts.
set -euo pipefail
wc -c <&0 >/dev/null
echo "whisper_full: input is not 16 kHz mono - no speech detected, skipping segment" >&2
exit 0
