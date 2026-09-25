#!/bin/bash
# D-263/D-264: faket whisper.cpp-binær som reproduserer det EKTE live-funnet
# på NAS-en - kode 0 (INGEN local_whisper_process_failed), men HELT TOMT
# stdout, mens whisper.cpp sin egen diagnostikk (modell-/"no speech"-info)
# fortsatt skrives til stderr. FØR D-263 ble denne stderr-en stille kastet
# bort på nøyaktig denne (suksess+tomt resultat) stien - se
# voice_stt_empty_result_diagnostic-kommentaren i stt.ts.
#
# D-264: den EKTE whisper.cpp sender FØRST et flerlinjers modell-laste-
# banner (GPU-init/flash-attn/dtw - se live-funnet i D-264 sin kommentar i
# stt.ts) FØR den nyttige diagnostikken - et for kort stderr-utdrag (300
# tegn, FØR denne fiksen) kuttet derfor av midt i banneret og viste ALDRI
# selve forklaringen. Denne fixturen gjenskaper akkurat den strukturen:
# et realistisk, flerlinjers banner FØRST, deretter selve "no speech"-
# linjen et godt stykke inn i utskriften - beviser at 4000-tegns-grensen
# faktisk når frem dit 300 tegn ikke gjorde.
set -euo pipefail
wc -c <&0 >/dev/null
cat >&2 <<'EOF'
whisper_init_from_file_with_params_no_state: loading model from '/opt/whisper/ggml-base.bin'
whisper_init_with_params_no_state: use gpu    = 1
whisper_init_with_params_no_state: flash attn = 1
whisper_init_with_params_no_state: gpu_device = 0
whisper_init_with_params_no_state: dtw        = 0
whisper_model_load: loading model
whisper_model_load: n_vocab       = 51865
whisper_model_load: n_audio_ctx   = 1500
whisper_model_load: n_audio_state = 512
whisper_model_load: n_audio_head  = 8
whisper_model_load: n_audio_layer = 6
whisper_model_load: n_text_ctx    = 448
whisper_model_load: n_text_state  = 512
whisper_model_load: n_text_head   = 8
whisper_model_load: n_text_layer  = 6
whisper_model_load: n_mels        = 80
whisper_model_load: ftype         = 1
whisper_model_load: type          = base
system_info: n_threads = 4 / 8 | AVX = 1 | AVX2 = 1 | FMA = 1 | NEON = 0
whisper_full: input is not 16 kHz mono - no speech detected, skipping segment
EOF
exit 0
